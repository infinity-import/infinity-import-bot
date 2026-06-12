const express  = require('express');
const TelegramBot = require('node-telegram-bot-api');
const admin   = require('firebase-admin');
const axios   = require('axios');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const XLSX    = require('xlsx');

// ── FIREBASE ──────────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  projectId: 'infinity-global-trade'
});
const db = admin.firestore();

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_TOKEN;
const bot   = new TelegramBot(TOKEN);
const app   = express();
app.use(express.json());

// Webhook endpoint (Render llama a esta URL cuando llega un mensaje)
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => res.send('Infinity Import Bot OK'));

// ── EXTRACCIÓN DE TEXTO ───────────────────────────────────────────────────────
async function extraerTexto(buffer, ext) {
  if (ext === 'pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (['xlsx', 'xls'].includes(ext)) {
    const wb = XLSX.read(buffer);
    let text = '';
    wb.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      rows.forEach(row => { text += row.join(' ') + '\n'; });
    });
    return text;
  }
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng+spa');
    return text;
  }
  return '';
}

// ── PARSEO DE DATOS ───────────────────────────────────────────────────────────
function parsear(text) {
  const clean = s => parseFloat(String(s).replace(/,/g, '').replace(/\s/g, '')) || 0;
  const result = {};

  // Monto factura — busca el mayor valor USD
  const amounts = [];
  const regs = [
    /(?:total\s+(?:amount|invoice|general|factura|importe)|grand\s+total|total\s+usd|amount\s+due)[\s:]*(?:usd|us\$|\$)?\s*([\d,]+\.?\d{0,2})/gi,
    /(?:usd|us\$)\s*([\d,]+\.?\d{0,2})/gi,
    /(?:total)[\s:]+\$?\s*([\d,]+\.?\d{0,2})/gi,
  ];
  for (const pat of regs) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const v = clean(m[1]);
      if (v > 100) amounts.push(v);
    }
  }
  if (amounts.length) result.factura = Math.max(...amounts);

  // Flete
  const fleteM = text.match(/(?:freight|flete|ocean\s*freight|air\s*freight|cargo\s*charge)[\s:]*(?:usd|us\$|\$)?\s*([\d,]+\.?\d{0,2})/i);
  if (fleteM) result.flete = clean(fleteM[1]);

  // Seguro
  const segM = text.match(/(?:insurance|seguro)[\s:]*(?:usd|us\$|\$)?\s*([\d,]+\.?\d{0,2})/i);
  if (segM) result.seguro = clean(segM[1]);

  // Fecha
  const dmy = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  const ymd = text.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (dmy) result.fecha = `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  else if (ymd) result.fecha = `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;

  // País origen
  const paises = ['China','India','USA','United States','Germany','Italy','Brazil','Spain','France','Japan','Vietnam','Bangladesh','Turkey','Taiwan','Mexico'];
  for (const p of paises) {
    if (new RegExp('\\b' + p + '\\b', 'i').test(text)) { result.origen = p; break; }
  }

  // NCM / HS Code
  const ncmM = text.match(/(?:ncm|hs[\s\-]?code|tariff[\s\-]?(?:code|no)|arancel)[\s:\.\#]*(\d{4}[\.\s]?\d{2}[\.\s]?\d{2})/i);
  if (ncmM) result.ncm = ncmM[1].replace(/\s/g, '.');

  // Producto
  const prodM = text.match(/(?:description\s+of\s+goods|goods\s+description|descripci[oó]n|product[\s:]+|mercader[ií]a[\s:]+)([A-Za-z][^\n\r]{5,70})/i);
  if (prodM) result.producto = prodM[1].trim().replace(/\s+/g, ' ').slice(0, 60);

  return result;
}

// ── PROCESAR ARCHIVO ──────────────────────────────────────────────────────────
async function procesarArchivo(fileId, fileName, chatId) {
  const ext = (fileName || '').split('.').pop().toLowerCase();

  // Descargar archivo desde Telegram
  const fileInfo = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(resp.data);

  // Extraer texto
  let text = await extraerTexto(buffer, ext);
  if (!text.trim()) throw new Error('No pude leer el contenido del archivo.');

  // Parsear datos
  const datos = parsear(text);
  const encontrados = Object.keys(datos).length;

  // Guardar en Firestore como cotización pendiente
  const docRef = await db.collection('cotizaciones').add({
    producto:       datos.producto  || fileName || 'Desde Telegram',
    factura:        datos.factura   || 0,
    flete:          datos.flete     || 0,
    seguro:         datos.seguro    || 0,
    fecha:          datos.fecha     || new Date().toISOString().slice(0, 10),
    origen:         datos.origen    || '',
    ncm:            datos.ncm       || '',
    p_di:           14,
    p_te:           3,
    p_iva:          21,
    p_ivaa:         10.5,
    p_ig:           6,
    p_iibb:         3,
    despachante:    0,
    deposito:       0,
    otros_aux:      0,
    confirmada:     false,
    origen_telegram: true,
    telegram_chat_id: String(chatId),
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  return { datos, docId: docRef.id, encontrados };
}

// ── FORMATEAR RESPUESTA ───────────────────────────────────────────────────────
function formatearRespuesta(datos, docId) {
  const nombres = {
    producto: '📦 Producto',
    factura:  '💵 Monto factura',
    flete:    '🚢 Flete',
    seguro:   '🛡️ Seguro',
    fecha:    '📅 Fecha',
    origen:   '🌍 Origen',
    ncm:      '🏷️ NCM',
  };
  const filas = Object.entries(datos)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${nombres[k] || k}: *${v}*`)
    .join('\n');

  return filas
    ? `✅ *Cotización creada en el sistema*\n\n${filas}\n\n_Abrí la app → Cotizaciones → confirmá como importación._`
    : `⚠️ Archivo recibido pero no pude extraer datos.\n_Entrá a la app → Cotizaciones y completá manualmente._`;
}

// ── HANDLERS ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    `👋 *¡Hola! Soy el asistente de Infinity Global Trade*\n\nMandame:\n📄 Factura proforma \\(PDF, Excel o foto\\)\n🚢 Documento de flete\n\nExtrae los datos automáticamente y creo la cotización en el sistema\\. Desde la app podés revisarla y confirmarla como importación\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

// Documentos (PDF, Excel, etc.)
bot.on('document', async msg => {
  const chatId = msg.chat.id;
  const file   = msg.document;
  const ext    = (file.file_name || '').split('.').pop().toLowerCase();
  const soportados = ['pdf', 'xlsx', 'xls', 'jpg', 'jpeg', 'png', 'webp'];

  if (!soportados.includes(ext)) {
    return bot.sendMessage(chatId, '⚠️ Formato no soportado. Mandá PDF, Excel o imagen JPG/PNG.');
  }

  const loadingMsg = await bot.sendMessage(chatId, ext === 'jpg' || ext === 'jpeg' || ext === 'png'
    ? '🔍 Leyendo imagen con OCR...'
    : '⏳ Procesando archivo...');

  try {
    const { datos, docId } = await procesarArchivo(file.file_id, file.file_name, chatId);
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, formatearRespuesta(datos, docId), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('document error:', err);
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// Fotos enviadas como imagen (no como archivo)
bot.on('photo', async msg => {
  const chatId = msg.chat.id;
  const photo  = msg.photo[msg.photo.length - 1]; // mayor resolución

  const loadingMsg = await bot.sendMessage(chatId, '🔍 Leyendo imagen con OCR...');

  try {
    const { datos, docId } = await procesarArchivo(photo.file_id, 'foto.jpg', chatId);
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, formatearRespuesta(datos, docId), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('photo error:', err);
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ── SERVER ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Infinity Bot corriendo en puerto ${PORT}`));
