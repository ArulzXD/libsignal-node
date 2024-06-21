import { SESSION_CIPHER_VERSION } from '../Types/constants'
import { ChainDeserialized, ChainType } from '../Types/Chains'
import { PreKeyDeserialized } from '../Types/PreKey'

import { ProtocolAddress } from './protocol-address'
import { SessionBuilder } from './session-builder'
import { SessionRecord } from './session-record'
import { SessionEntry } from "./session-entry"
import { queueJob } from '../Utils/queue-job'

import * as crypto from '../Utils/crypto'
import * as curve from '../Utils/curve'
import * as errors from '../Utils/errors'
import * as proto from '../../WhisperTextProto/index'


export class SessionCipher {
    private addr: ProtocolAddress
    private storage: any

    constructor(storage: any, protocolAddress: ProtocolAddress) {
        this.addr = protocolAddress;
        this.storage = storage;
    }

    private _encodeTupleByte(number1: number, number2: number) {
        if (number1 > 15 || number2 > 15) {
            throw TypeError("Numbers must be 4 bits or less");
        }
        return (number1 << 4) | number2;
    }

    private _decodeTupleByte(byte: number) {
        return [byte >> 4, byte & 0xf];
    }

    toString() {
        return `<SessionCipher(${this.addr.toString()})>`;
    }

    async getRecord() {
        const record = await this.storage.loadSession(this.addr.toString());
        if (record && !(record instanceof SessionRecord)) {
            throw new TypeError('SessionRecord type expected from loadSession'); 
        }
        return record;
    }

    async storeRecord(record: SessionRecord) {
        record.removeOldSessions();
        await this.storage.storeSession(this.addr.toString(), record);
    }

    async queueJob(awaitable: () => Promise<any>) {
        return await queueJob(this.addr.toString(), awaitable);
    }

    async encrypt(data: Buffer | Uint8Array) {
        const ourIdentityKey = await this.storage.getOurIdentity();
        return await this.queueJob(async () => {
            const record = await this.getRecord();
            if (!record) {
                throw new errors.SessionError("No sessions");
            }
            const session = record.getOpenSession();
            if (!session) {
                throw new errors.SessionError("No open session");
            }
            const remoteIdentityKey = session.indexInfo.remoteIdentityKey;
            if (!await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey)) {
                throw new errors.UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey);
            }
            const chain = session.getChain(session.currentRatchet.ephemeralKeyPair.pubKey);
            if (chain.chainType === ChainType.RECEIVING) {
                throw new Error("Tried to encrypt on a receiving chain");
            }
            this.fillMessageKeys(chain, chain.chainKey.counter + 1);
            const keys = crypto.deriveSecrets(
                chain.messageKeys[chain.chainKey.counter],
                Buffer.alloc(32),
                Buffer.from("WhisperMessageKeys")
            );
            delete chain.messageKeys[chain.chainKey.counter];
            const msg = proto.textsecure.WhisperMessage.create();
            msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey;
            msg.counter = chain.chainKey.counter;
            msg.previousCounter = session.currentRatchet.previousCounter;
            msg.ciphertext = crypto.encrypt(keys[0], data, keys[2].slice(0, 16));
            const msgBuf = proto.textsecure.WhisperMessage.encode(msg).finish();
            const macInput = Buffer.alloc(msgBuf.byteLength + (33 * 2) + 1);
            macInput.set(ourIdentityKey.pubKey);
            macInput.set(session.indexInfo.remoteIdentityKey, 33);
            macInput[33 * 2] = this._encodeTupleByte(SESSION_CIPHER_VERSION, SESSION_CIPHER_VERSION);
            macInput.set(msgBuf, (33 * 2) + 1);
            const mac = crypto.calculateMAC(keys[1], macInput);
            const result = Buffer.alloc(msgBuf.byteLength + 9);
            result[0] = this._encodeTupleByte(SESSION_CIPHER_VERSION, SESSION_CIPHER_VERSION);
            result.set(msgBuf, 1);
            result.set(mac.slice(0, 8), msgBuf.byteLength + 1);
            await this.storeRecord(record);
            let type, body;
            if (session.pendingPreKey) {
                type = 3;  // prekey bundle
                const preKeyMsg = proto.textsecure.PreKeyWhisperMessage.create({
                    identityKey: ourIdentityKey.pubKey,
                    registrationId: await this.storage.getOurRegistrationId(),
                    baseKey: session.pendingPreKey.baseKey,
                    signedPreKeyId: session.pendingPreKey.signedKeyId,
                    message: result
                });
                if (session.pendingPreKey.preKeyId) {
                    preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
                }
                body = Buffer.concat([
                    Buffer.from([this._encodeTupleByte(SESSION_CIPHER_VERSION, SESSION_CIPHER_VERSION)]),
                    Buffer.from(
                        proto.textsecure.PreKeyWhisperMessage.encode(preKeyMsg).finish()
                    )
                ]);
            } else {
                type = 1;  // normal
                body = result;
            }
            return {
                type,
                body,
                registrationId: session.registrationId
            };
        });
    }

    async decryptWithSessions(data: Buffer | Uint8Array, sessions: SessionEntry[]) {
        // Iterate through the sessions, attempting to decrypt using each one.
        // Stop and return the result if we get a valid result.
        if (!sessions.length) {
            throw new errors.SessionError("No sessions available");
        }   
        const errs: Error[] = [];
        for (const session of sessions) {
            let plaintext; 
            try {
                plaintext = await this.doDecryptWhisperMessage(data, session);
                session.indexInfo.used = Date.now();
                return {
                    session,
                    plaintext
                };
            } catch(e) {
                errs.push(e as Error);
            }
        }
        console.error("Failed to decrypt message with any known session...");
        for (const e of errs) {
            console.error("Session error:" + e, e.stack);
        }
        throw new errors.SessionError("No matching sessions found for message");
    }

    async decryptWhisperMessage(data: Buffer | Uint8Array) {
        return await this.queueJob(async () => {
            const record = await this.getRecord();
            if (!record) {
                throw new errors.SessionError("No session record");
            }
            const result = await this.decryptWithSessions(data, record.getSessions());
            const remoteIdentityKey = result.session.indexInfo.remoteIdentityKey;
            if (!await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey)) {
                throw new errors.UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey);
            }   
            if (record.isClosed(result.session)) {
                // It's possible for this to happen when processing a backlog of messages.
                // The message was, hopefully, just sent back in a time when this session
                // was the most current.  Simply make a note of it and continue.  If our
                // actual open session is for reason invalid, that must be handled via
                // a full SessionError response.
                console.warn("Decrypted message with closed session.");
            }
            await this.storeRecord(record);
            return result.plaintext;
        });
    }

    async decryptPreKeyWhisperMessage(data: Buffer) {
        const versions = this._decodeTupleByte(data[0]);
        if (versions[1] > 3 || versions[0] < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on PreKeyWhisperMessage");
        }
        return await this.queueJob(async () => {
            let record = await this.getRecord();
            const preKeyProto = proto.textsecure.PreKeyWhisperMessage.decode(data.slice(1));
            if (!record) {
                if (preKeyProto.registrationId == null) {
                    throw new Error("No registrationId");
                }
                record = new SessionRecord();
            }
            const builder = new SessionBuilder(this.storage, this.addr);
            const preKeyId = await builder.initIncoming(record, preKeyProto);
            const session = record.getSession(preKeyProto.baseKey);
            const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message as Buffer, session);
            await this.storeRecord(record);
            if (preKeyId) {
                await this.storage.removePreKey(preKeyId);
            }
            return plaintext;
        });
    }

    async doDecryptWhisperMessage(messageBuffer: Buffer | Uint8Array, session: SessionEntry) {
        if (!session) {
            throw new TypeError("session required");
        }
        const versions = this._decodeTupleByte(messageBuffer[0]);
        if (versions[1] > 3 || versions[0] < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on WhisperMessage");
        }
        const messageProto = messageBuffer.slice(1, -8);
        const message = proto.textsecure.WhisperMessage.decode(messageProto);
        this.maybeStepRatchet(session, message.ephemeralKey as Buffer, message.previousCounter);
        const chain = session.getChain(message.ephemeralKey);
        if (chain.chainType === ChainType.SENDING) {
            throw new Error("Tried to decrypt on a sending chain");
        }
        this.fillMessageKeys(chain, message.counter);
        if (!chain.messageKeys.hasOwnProperty(message.counter)) {
            // Most likely the message was already decrypted and we are trying to process
            // twice.  This can happen if the user restarts before the server gets an ACK.
            throw new errors.MessageCounterError('Key used already or never filled');
        }
        const messageKey = chain.messageKeys[message.counter];
        delete chain.messageKeys[message.counter];
        const keys = crypto.deriveSecrets(
            messageKey, Buffer.alloc(32),
            Buffer.from("WhisperMessageKeys")
        );
        const ourIdentityKey = await this.storage.getOurIdentity();
        const macInput = Buffer.alloc(messageProto.byteLength + (33 * 2) + 1);
        macInput.set(session.indexInfo.remoteIdentityKey);
        macInput.set(ourIdentityKey.pubKey, 33);
        macInput[33 * 2] = this._encodeTupleByte(SESSION_CIPHER_VERSION, SESSION_CIPHER_VERSION);
        macInput.set(messageProto, (33 * 2) + 1);
        // This is where we most likely fail if the session is not a match.
        // Don't misinterpret this as corruption.
        crypto.verifyMAC(macInput, keys[1], messageBuffer.slice(-8), 8);
        const plaintext = crypto.decrypt(keys[0], message.ciphertext, keys[2].slice(0, 16));
        delete session.pendingPreKey;
        return plaintext;
    }

    fillMessageKeys(chain: ChainDeserialized, counter: number): void{
        if (chain.chainKey.counter >= counter) {
            return;
        }
        if (counter - chain.chainKey.counter > 2000) {
            throw new errors.SessionError('Over 2000 messages into the future!');
        }
        if (chain.chainKey.key === undefined) {
            throw new errors.SessionError('Chain closed');
        }
        const key = chain.chainKey.key;
        chain.messageKeys[chain.chainKey.counter + 1] = crypto.calculateMAC(key as Buffer, Buffer.from([1]));
        chain.chainKey.key = crypto.calculateMAC(key as Buffer, Buffer.from([2]));
        chain.chainKey.counter += 1;
        return this.fillMessageKeys(chain, counter);
    }

    maybeStepRatchet(session: SessionEntry, remoteKey: Buffer, previousCounter: number) {
        if (session.getChain(remoteKey)) {
            return;
        }
        const ratchet = session.currentRatchet;
        let previousRatchet = session.getChain(ratchet.lastRemoteEphemeralKey);
        if (previousRatchet) {
            this.fillMessageKeys(previousRatchet, previousCounter);
            delete previousRatchet.chainKey.key;  // Close
        }
        this.calculateRatchet(session, remoteKey, false);
        // Now swap the ephemeral key and calculate the new sending chain
        const prevCounter = session.getChain(ratchet.ephemeralKeyPair.pubKey);
        if (prevCounter) {
            ratchet.previousCounter = prevCounter.chainKey.counter;
            session.deleteChain(ratchet.ephemeralKeyPair.pubKey);
        }
        ratchet.ephemeralKeyPair = curve.generateKeyPair();
        this.calculateRatchet(session, remoteKey, true);
        ratchet.lastRemoteEphemeralKey = remoteKey;
    }

    calculateRatchet(session: SessionEntry, remoteKey: Buffer, sending: boolean) {
        let ratchet = session.currentRatchet;
        const sharedSecret = curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
        const masterKey = crypto.deriveSecrets(
            sharedSecret,
            ratchet.rootKey,
            Buffer.from("WhisperRatchet"),
            /*chunks*/ 2);

        const chainKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey;
        session.addChain(chainKey, {
            messageKeys: {},
            chainKey: {
                counter: -1,
                key: masterKey[1]
            },
            chainType: sending ? ChainType.SENDING : ChainType.RECEIVING
        });

        ratchet.rootKey = masterKey[0];
    }

    async hasOpenSession() {
        return await this.queueJob(async () => {
            const record = await this.getRecord();
            if (!record) {
                return false;
            }
            return record.haveOpenSession();
        });
    }

    async closeOpenSession() {
        return await this.queueJob(async () => {
            const record = await this.getRecord();
            if (record) {
                const openSession = record.getOpenSession();
                if (openSession) {
                    record.closeSession(openSession);
                    await this.storeRecord(record);
                }
            }
        });
    }
}
