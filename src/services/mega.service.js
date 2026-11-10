const Mega = require('megajs');
const crypto = require('crypto');
const config = require('../utils/config');

function encrypt(buffer) {
  if (!config.encryptionKey) throw new Error('SESSION_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('XDWS1'), iv, cipher.getAuthTag(), ciphertext]);
}
function decrypt(buffer) {
  if (!config.encryptionKey) throw new Error('SESSION_ENCRYPTION_KEY is not configured');
  if (buffer.subarray(0, 5).toString() !== 'XDWS1') throw new Error('Unknown backup format');
  const iv = buffer.subarray(5, 17);
  const tag = buffer.subarray(17, 33);
  const ciphertext = buffer.subarray(33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
async function getStorage() {
  if (!config.megaEmail || !config.megaPassword) throw new Error('MEGA credentials are not configured');
  const storage = new Mega.Storage({ email: config.megaEmail, password: config.megaPassword });
  await storage.ready;
  return storage;
}
async function uploadSession(chatId, phone, jsonBuffer) {
  const storage = await getStorage();
  const root = storage.root;
  const base = await root.mkdir({ name: 'XD-WS-CHECKER-BOT' }).catch(async () => {
    return root.children.find((f) => f.name === 'XD-WS-CHECKER-BOT');
  });
  if (!base) throw new Error('Could not create/find private MEGA root folder');
  const userFolder = await base.mkdir({ name: String(chatId) }).catch(async () => {
    return base.children.find((f) => f.name === String(chatId));
  });
  if (!userFolder) throw new Error('Could not create/find user MEGA folder');

  const encrypted = encrypt(jsonBuffer);
  const uploaded = await userFolder.upload({ name: `${phone}.json.enc` }, encrypted).complete;
  return { fileId: String(uploaded.nodeId || uploaded.node || uploaded.name), storage };
}
async function downloadSession(fileId) {
  const storage = await getStorage();
  const node = storage.files.find((f) => String(f.nodeId || f.node || f.name) === String(fileId));
  if (!node) throw new Error('Private MEGA backup not found');
  const data = await node.downloadBuffer();
  return decrypt(Buffer.from(data));
}
async function deletePrivateBackup(fileId) {
  const storage = await getStorage();
  const node = storage.files.find((f) => String(f.nodeId || f.node || f.name) === String(fileId));
  if (node) await node.delete();
}
module.exports = { uploadSession, downloadSession, deletePrivateBackup };
