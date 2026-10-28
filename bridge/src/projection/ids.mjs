export const deliverableId = (sessionId, seq, index) => `d.${Buffer.from(sessionId).toString('base64url')}.${seq}.${index}`;
