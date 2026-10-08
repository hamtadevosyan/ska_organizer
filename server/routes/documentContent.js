module.exports = (res, file) => {
  const asciiName = file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(file.filename).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  res.set({ 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache', 'Expires': '0',
    'Content-Type': file.contentType, 'Content-Length': String(file.byteLength),
    'Content-Disposition': (file.download ? 'attachment' : 'inline') + '; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodedName,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.status(200).end(file.content);
};
