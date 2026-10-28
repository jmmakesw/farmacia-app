'use strict';
// Leitor mínimo de multipart/form-data: campos de texto + no máximo um ficheiro.
const { HttpError } = require('./security');

const MAX_FIELDS = 20;
const MAX_FIELD_BYTES = 20_000;

// Lê o corpo até `limit` bytes. Se for maior, descarta o excedente (para o cliente receber
// a resposta 413 em vez de a ligação ser cortada) e corta a ligação apenas em excessos enormes.
function readBody(req, limit) {
  const tooBigError = () => new HttpError(413, 'O ficheiro ou pedido é demasiado grande.');
  return new Promise((resolve, reject) => {
    const hardCap = limit * 8;
    if (Number(req.headers['content-length']) > hardCap) {
      reject(tooBigError());
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > hardCap) {
        req.destroy();
        reject(tooBigError());
        return;
      }
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(tooBigError());
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw new HttpError(400, 'Pedido inválido.');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const delimiter = Buffer.from('\r\n--' + (m[1] || m[2]));

  const fields = {};
  let file = null;
  let count = 0;

  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // fim
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) throw new HttpError(400, 'Pedido inválido.');
    const headers = buf.toString('utf8', pos, headerEnd);
    const start = headerEnd + 4;
    const next = buf.indexOf(delimiter, start);
    if (next === -1) throw new HttpError(400, 'Pedido inválido.');
    const body = buf.subarray(start, next);

    const disp = /^content-disposition:[^\r\n]*$/im.exec(headers);
    const nameMatch = disp && /\bname="([^"]*)"/i.exec(disp[0]);
    const fileMatch = disp && /\bfilename="([^"]*)"/i.exec(disp[0]);
    if (nameMatch) {
      if (++count > MAX_FIELDS) throw new HttpError(400, 'Pedido inválido.');
      if (fileMatch) {
        if (file) throw new HttpError(400, 'Só é permitido um ficheiro.');
        if (body.length > 0) file = { field: nameMatch[1], data: Buffer.from(body) };
      } else {
        if (body.length > MAX_FIELD_BYTES) throw new HttpError(400, 'Pedido inválido.');
        fields[nameMatch[1]] = body.toString('utf8');
      }
    }
    pos = next + 2; // aponta para o início do próximo delimitador
  }
  return { fields, file };
}

module.exports = { readBody, parseMultipart };
