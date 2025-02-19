/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ConnectionMode,
    IClient,
    IConnect,
    IConnected,
    IDocumentMessage,
    INack,
    ISignalClient,
    ISignalMessage,
    MessageType,
    NackErrorType,
    ScopeType,
} from "@fluidframework/protocol-definitions";
import {
    canSummarize,
    canWrite,
    validateTokenClaims,
    validateTokenClaimsExpiration,
} from "@fluidframework/server-services-client";

import safeStringify from "json-stringify-safe";
import * as semver from "semver";
import * as core from "@fluidframework/server-services-core";
import {
    BaseTelemetryProperties,
    CommonProperties,
    LumberEventName,
    Lumberjack,
    getLumberBaseProperties,
} from "@fluidframework/server-services-telemetry";
import {
    createRoomJoinMessage,
    createNackMessage,
    createRoomLeaveMessage,
    getRandomInt,
    generateClientId,
} from "../utils";

const summarizerClientType = "summarizer";

interface IRoom {

    tenantId: string;

    documentId: string;
}

interface IConnectedClient {

    connection: IConnected;

    details: IClient;

    connectVersions: string[];
}

// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
function getRoomId(room: IRoom) {
    return `${room.tenantId}/${room.documentId}`;
}

const getMessageMetadata = (documentId: string, tenantId: string) => ({
    documentId,
    tenantId,
});

const handleServerError = async (logger: core.ILogger, errorMessage: string, documentId: string, tenantId: string) => {
    logger.error(errorMessage, { messageMetaData: getMessageMetadata(documentId, tenantId) });
    Lumberjack.error(errorMessage, getLumberBaseProperties(documentId, tenantId));
    // eslint-disable-next-line prefer-promise-reject-errors
    return Promise.reject({ code: 500, message: "Failed to connect client to document." });
};

const getSocketConnectThrottleId = (tenantId: string) => `${tenantId}_OpenSocketConn`;

const getSubmitOpThrottleId = (clientId: string, tenantId: string) => `${clientId}_${tenantId}_SubmitOp`;

// Sanitize the received op before sending.
function sanitizeMessage(message: any): IDocumentMessage {
    // Trace sampling.
    if (message.operation && message.operation.traces && getRandomInt(100) === 0) {
        message.operation.traces.push(
            {
                action: "start",
                service: "alfred",
                timestamp: Date.now(),
            });
    }
    const sanitizedMessage: IDocumentMessage = {
        clientSequenceNumber: message.clientSequenceNumber,
        contents: message.contents,
        metadata: message.metadata,
        referenceSequenceNumber: message.referenceSequenceNumber,
        traces: message.traces,
        type: message.type,
    };

    return sanitizedMessage;
}

const protocolVersions = ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"];

function selectProtocolVersion(connectVersions: string[]): string | undefined {
    for (const connectVersion of connectVersions) {
        for (const protocolVersion of protocolVersions) {
            if (semver.intersects(protocolVersion, connectVersion)) {
                return protocolVersion;
            }
        }
    }
}

/**
 * @returns ThrottlingError if throttled; undefined if not throttled or no throttler provided.
 */
function checkThrottle(
    throttler: core.IThrottler | undefined,
    throttleId: string,
    tenantId: string,
    logger?: core.ILogger): core.ThrottlingError | undefined {
    if (!throttler) {
        return;
    }

    try {
        throttler.incrementCount(throttleId);
    } catch (error) {
        if (error instanceof core.ThrottlingError) {
            return error;
        } else {
            logger?.error(
                `Throttle increment failed: ${safeStringify(error, undefined, 2)}`,
                {
                    messageMetaData: {
                        key: throttleId,
                        eventName: "throttling",
                    },
                });
            Lumberjack.error(`Throttle increment failed`, {
                [CommonProperties.telemetryGroupName]: "throttling",
                [BaseTelemetryProperties.tenantId]: tenantId,
            }, error);
        }
    }
}

export function configureWebSocketServices(
    webSocketServer: core.IWebSocketServer,
    orderManager: core.IOrdererManager,
    tenantManager: core.ITenantManager,
    storage: core.IDocumentStorage,
    clientManager: core.IClientManager,
    metricLogger: core.IMetricClient,
    logger: core.ILogger,
    maxNumberOfClientsPerDocument: number = 1000000,
    maxTokenLifetimeSec: number = 60 * 60,
    isTokenExpiryEnabled: boolean = false,
    connectThrottler?: core.IThrottler,
    submitOpThrottler?: core.IThrottler) {
    webSocketServer.on("connection", (socket: core.IWebSocket) => {
        // Map from client IDs on this connection to the object ID and user info.
        const connectionsMap = new Map<string, core.IOrdererConnection>();
        // Map from client IDs to room.
        const roomMap = new Map<string, IRoom>();
        // Map from client Ids to scope.
        const scopeMap = new Map<string, string[]>();

        // Timer to check token expiry for this socket connection
        let expirationTimer: NodeJS.Timer | undefined;

        const hasWriteAccess = (scopes: string[]) => canWrite(scopes) || canSummarize(scopes);

        function isWriter(scopes: string[], mode: ConnectionMode): boolean {
            if (hasWriteAccess(scopes)) {
                return mode === "write";
            } else {
                return false;
            }
        }

        function clearExpirationTimer() {
            if (expirationTimer !== undefined) {
                clearTimeout(expirationTimer);
                expirationTimer = undefined;
            }
        }

        function setExpirationTimer(mSecUntilExpiration: number) {
            clearExpirationTimer();
            expirationTimer = setTimeout(() => {
                socket.disconnect(true);
            }, mSecUntilExpiration);
        }

        async function connectDocument(message: IConnect): Promise<IConnectedClient> {
            const throttleError = checkThrottle(
                connectThrottler,
                getSocketConnectThrottleId(message.tenantId),
                message.tenantId,
                logger);
            if (throttleError) {
                return Promise.reject(throttleError);
            }
            if (!message.token) {
                // eslint-disable-next-line prefer-promise-reject-errors
                return Promise.reject({
                    code: 403,
                    message: "Must provide an authorization token",
                });
            }

            // Validate token signature and claims
            const token = message.token;
            const claims = validateTokenClaims(token,
                message.id,
                message.tenantId);

            try {
                await tenantManager.verifyToken(claims.tenantId, token);
            } catch (err) {
                // eslint-disable-next-line prefer-promise-reject-errors
                return Promise.reject({
                    // if we don't understand the error, be lenient and allow retry
                    code: err?.response?.status ?? 401,
                    message: err?.response?.data ?? "Invalid token",
                });
            }

            const clientId = generateClientId();
            const room: IRoom = {
                tenantId: claims.tenantId,
                documentId: claims.documentId,
            };

            try {
                // Subscribe to channels.
                await Promise.all([
                    socket.join(getRoomId(room)),
                    socket.join(`client#${clientId}`)]);
            } catch (err) {
                const errMsg = `Could not subscribe to channels. Error: ${safeStringify(err, undefined, 2)}`;
                return handleServerError(logger, errMsg, claims.documentId, claims.tenantId);
            }

            const connectedTimestamp = Date.now();

            // Todo: should all the client details come from the claims???
            // we are still trusting the users permissions and type here.
            const messageClient: Partial<IClient> = message.client ? message.client : {};
            const isSummarizer = messageClient.details?.type === summarizerClientType;
            messageClient.user = claims.user;
            messageClient.scopes = claims.scopes;

            // Do not give SummaryWrite scope to clients that are not summarizers
            if (!isSummarizer) {
                messageClient.scopes = claims.scopes.filter((scope) => scope !== ScopeType.SummaryWrite);
            }

            // back-compat: remove cast to any once new definition of IClient comes through.
            (messageClient as any).timestamp = connectedTimestamp;

            // Cache the scopes.
            scopeMap.set(clientId, messageClient.scopes);

            // Join the room to receive signals.
            roomMap.set(clientId, room);
            // Iterate over the version ranges provided by the client and select the best one that works
            const connectVersions = message.versions ? message.versions : ["^0.1.0"];
            const version = selectProtocolVersion(connectVersions);
            if (!version) {
                // eslint-disable-next-line prefer-promise-reject-errors
                return Promise.reject({
                    code: 400,
                    message: `Unsupported client protocol. ` +
                        `Server: ${protocolVersions}. ` +
                        `Client: ${JSON.stringify(connectVersions)}`,
                });
            }

            const clients = await getClients(claims.tenantId, claims.documentId);

            if (clients.length > maxNumberOfClientsPerDocument) {
                // eslint-disable-next-line prefer-promise-reject-errors
                return Promise.reject({
                    code: 429,
                    message: "Too Many Clients Connected to Document",
                    retryAfter: 5 * 60,
                });
            }

            try {
                await clientManager.addClient(
                    claims.tenantId,
                    claims.documentId,
                    clientId,
                    messageClient as IClient);
            } catch (err) {
                const errMsg = `Could not add client. Error: ${safeStringify(err, undefined, 2)}`;
                return handleServerError(logger, errMsg, claims.documentId, claims.tenantId);
            }

            if (isTokenExpiryEnabled) {
                const lifeTimeMSec = validateTokenClaimsExpiration(claims, maxTokenLifetimeSec);
                setExpirationTimer(lifeTimeMSec);
            }

            let connectedMessage: IConnected;
            if (isWriter(messageClient.scopes, message.mode)) {
                const orderer = await orderManager.getOrderer(claims.tenantId, claims.documentId)
                    .catch(async (err) => {
                        const errMsg = `Failed to get orderer manager. Error: ${safeStringify(err, undefined, 2)}`;
                        return handleServerError(logger, errMsg, claims.documentId, claims.tenantId);
                    });

                const connection = await orderer.connect(socket, clientId, messageClient as IClient)
                    .catch(async (err) => {
                        const errMsg = `Failed to connect to orderer. Error: ${safeStringify(err, undefined, 2)}`;
                        return handleServerError(logger, errMsg, claims.documentId, claims.tenantId);
                    });

                // Eventually we will send disconnect reason as headers to client.
                connection.once("error", (error) => {
                    const messageMetaData = getMessageMetadata(connection.documentId, connection.tenantId);

                    // eslint-disable-next-line max-len
                    logger.error(`Disconnecting socket on connection error: ${safeStringify(error, undefined, 2)}`, { messageMetaData });
                    Lumberjack.error(
                        `Disconnecting socket on connection error`,
                        getLumberBaseProperties(connection.documentId, connection.tenantId),
                        error,
                    );
                    clearExpirationTimer();
                    socket.disconnect(true);
                });

                connection.connect()
                    .catch(async (err) => {
                        // eslint-disable-next-line max-len
                        const errMsg = `Failed to connect to the orderer connection. Error: ${safeStringify(err, undefined, 2)}`;
                        return handleServerError(logger, errMsg, claims.documentId, claims.tenantId);
                    });

                connectionsMap.set(clientId, connection);

                connectedMessage = {
                    claims,
                    clientId,
                    existing: true,
                    maxMessageSize: connection.maxMessageSize,
                    mode: "write",
                    serviceConfiguration: {
                        blockSize: connection.serviceConfiguration.blockSize,
                        maxMessageSize: connection.serviceConfiguration.maxMessageSize,
                        summary: connection.serviceConfiguration.summary,
                    },
                    initialClients: clients,
                    initialMessages: [],
                    initialSignals: [],
                    supportedVersions: protocolVersions,
                    version,
                };
            } else {
                connectedMessage = {
                    claims,
                    clientId,
                    existing: true,
                    maxMessageSize: 1024, // Readonly client can't send ops.
                    mode: "read",
                    serviceConfiguration: {
                        blockSize: core.DefaultServiceConfiguration.blockSize,
                        maxMessageSize: core.DefaultServiceConfiguration.maxMessageSize,
                        summary: core.DefaultServiceConfiguration.summary,
                    },
                    initialClients: clients,
                    initialMessages: [],
                    initialSignals: [],
                    supportedVersions: protocolVersions,
                    version,
                };
            }

            // back-compat: remove cast to any once new definition of IConnected comes through.
            (connectedMessage as any).timestamp = connectedTimestamp;

            return {
                connection: connectedMessage,
                connectVersions,
                details: messageClient as IClient,
            };
        }

        async function getClients(tenantId: string, documentId: string): Promise<ISignalClient[]> {
            const clients = await clientManager.getClients(tenantId, documentId)
                .catch(async (err) => {
                    const errMsg = `Failed to get clients. Error: ${safeStringify(err, undefined, 2)}`;
                    return handleServerError(logger, errMsg, documentId, tenantId);
                });
            return clients;
        }

        // Note connect is a reserved socket.io word so we use connect_document to represent the connect request
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        socket.on("connect_document", async (connectionMessage: IConnect) => {
            const connectMetric = Lumberjack.newLumberMetric(LumberEventName.ConnectDocument);
            connectMetric.setProperties(getLumberBaseProperties(connectionMessage.id, connectionMessage.tenantId));

            connectDocument(connectionMessage).then(
                (message) => {
                    socket.emit("connect_document_success", message.connection);
                    const room = roomMap.get(message.connection.clientId);
                    if (room) {
                        socket.emitToRoom(
                            getRoomId(room),
                            "signal",
                            createRoomJoinMessage(message.connection.clientId, message.details));
                    }

                    connectMetric.setProperties({
                        [CommonProperties.clientId]: message.connection.clientId,
                        [CommonProperties.clientCount]: message.connection.initialClients.length + 1,
                        [CommonProperties.clientType]: message.details.details?.type,
                    });
                    connectMetric.success(`Connect document successful`);
                },
                (error) => {
                    socket.emit("connect_document_error", error);
                    connectMetric.error(`Connect document failed`, error);
                });
        });

        // Message sent when a new operation is submitted to the router
        socket.on(
            "submitOp",
            (clientId: string, messageBatches: (IDocumentMessage | IDocumentMessage[])[]) => {
                // Verify the user has an orderer connection.
                const connection = connectionsMap.get(clientId);
                if (!connection) {
                    let nackMessage: INack;
                    const clientScope = scopeMap.get(clientId);
                    if (clientScope && hasWriteAccess(clientScope)) {
                        nackMessage = createNackMessage(400, NackErrorType.BadRequestError, "Readonly client");
                    } else if (roomMap.has(clientId)) {
                        nackMessage = createNackMessage(403, NackErrorType.InvalidScopeError, "Invalid scope");
                    } else {
                        nackMessage = createNackMessage(400, NackErrorType.BadRequestError, "Nonexistent client");
                    }

                    socket.emit("nack", "", [nackMessage]);
                } else {
                    const throttleError = checkThrottle(
                        submitOpThrottler,
                        getSubmitOpThrottleId(clientId, connection.tenantId),
                        connection.tenantId,
                        logger);
                    if (throttleError) {
                        const nackMessage = createNackMessage(
                            throttleError.code,
                            NackErrorType.ThrottlingError,
                            throttleError.message,
                            throttleError.retryAfter);
                        socket.emit("nack", "", [nackMessage]);
                        return;
                    }

                    messageBatches.forEach((messageBatch) => {
                        const messages = Array.isArray(messageBatch) ? messageBatch : [messageBatch];
                        const sanitized = messages
                            .filter((message) => {
                                if (message.type === MessageType.RoundTrip) {
                                    if (message.traces) {
                                        // End of tracking. Write traces.
                                        // TODO: add Lumber metric here?
                                        metricLogger.writeLatencyMetric("latency", message.traces).catch(
                                            (error) => {
                                                logger.error(error.stack);
                                                Lumberjack.error(error.stack);
                                            });
                                    }
                                    return false;
                                } else {
                                    return true;
                                }
                            })
                            .map((message) => sanitizeMessage(message));

                        if (sanitized.length > 0) {
                            // eslint-disable-next-line @typescript-eslint/no-floating-promises
                            connection.order(sanitized);
                        }
                    });
                }
            });

        // Message sent when a new signal is submitted to the router
        socket.on(
            "submitSignal",
            (clientId: string, contentBatches: (IDocumentMessage | IDocumentMessage[])[]) => {
                // Verify the user has subscription to the room.
                const room = roomMap.get(clientId);
                if (!room) {
                    const nackMessage = createNackMessage(400, NackErrorType.BadRequestError, "Nonexistent client");
                    socket.emit("nack", "", [nackMessage]);
                } else {
                    contentBatches.forEach((contentBatche) => {
                        const contents = Array.isArray(contentBatche) ? contentBatche : [contentBatche];

                        for (const content of contents) {
                            const signalMessage: ISignalMessage = {
                                clientId,
                                content,
                            };

                            socket.emitToRoom(getRoomId(room), "signal", signalMessage);
                        }
                    });
                }
            });

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        socket.on("disconnect", async () => {
            clearExpirationTimer();
            // Send notification messages for all client IDs in the connection map
            for (const [clientId, connection] of connectionsMap) {
                const messageMetaData = getMessageMetadata(connection.documentId, connection.tenantId);
                logger.info(`Disconnect of ${clientId}`, { messageMetaData });
                Lumberjack.info(
                    `Disconnect of ${clientId}`,
                    getLumberBaseProperties(connection.documentId, connection.tenantId),
                );
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                connection.disconnect();
            }
            // Send notification messages for all client IDs in the room map
            const removeP: Promise<void>[] = [];
            for (const [clientId, room] of roomMap) {
                const messageMetaData = getMessageMetadata(room.documentId, room.tenantId);
                logger.info(`Disconnect of ${clientId} from room`, { messageMetaData });
                Lumberjack.info(
                    `Disconnect of ${clientId} from room`,
                    getLumberBaseProperties(room.documentId, room.tenantId),
                );
                removeP.push(clientManager.removeClient(room.tenantId, room.documentId, clientId));
                socket.emitToRoom(getRoomId(room), "signal", createRoomLeaveMessage(clientId));
            }
            await Promise.all(removeP);
        });

        socket.on("get_clients", (clientId: string) => {
            // Verify the user has subscription to the room.
            const room = roomMap.get(clientId);
            if (!room) {
                const nackMessage = createNackMessage(400, NackErrorType.BadRequestError, "Nonexistent client");
                socket.emit("nack", "", [nackMessage]);
            } else {
                void getClients(room.tenantId, room.documentId).then(
                    (clients) => {
                        socket.emitToRoom(
                            getRoomId(room),
                            "connected_clients",
                            clients);
                    });
            }
        });

        socket.on("ping", (clientId: string) => {
            // Verify the user has subscription to the room.
            const room = roomMap.get(clientId);
            if (!room) {
                const nackMessage = createNackMessage(400, NackErrorType.BadRequestError, "Nonexistent client");
                socket.emit("nack", "", [nackMessage]);
            } else {
                socket.emitToRoom(getRoomId(room),"pong", clientId);
            }
        });
    });
}
