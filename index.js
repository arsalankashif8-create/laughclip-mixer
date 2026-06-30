const express  = require('express');
const fetch    = require('node-fetch');
const ffmpeg   = require('fluent-ffmpeg');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { v4: uuidv4 } = require('uuid');
const crypto   = require('crypto');
const admin    = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Firebase Admin init ─────────────────────────────────────────────────────
let db = null;
try {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson) {
    const serviceAccount = JSON.parse(saJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — backfill endpoint disabled');
  }
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}

// R2 config
const R2_ACCOUNT_ID = 'e8409ad0379b3627b71fdab04c341444';
const R2_ACCESS_KEY = 'cc425bd21cd519d216183baf7ef11327';
const R2_SECRET_KEY = 'c744e387a602669921334bf3c62c7d724e859c86ceb7fa1a9d61b1a864de5287';
const R2_BUCKET     = 'laugh';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const CDN_BASE      = 'https://cdn.laughclip.online';

// AWS Signature V4
function sign(key, msg, binary = false) {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(msg);
  return binary ? hmac.digest() : hmac.digest('hex');
}

async function uploadToR2(filePath, r2Key, contentType = 'video/mp4') {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 16) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host      = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const fileBytes = fs.readFileSync(filePath);
  const payHash   = crypto.createHash('sha256').update(fileBytes).digest('hex');

  const hdrs = {
    'content-type':         contentType,
    'host':                 host,
    'x-amz-content-sha256': payHash,
    'x-amz-date':           amzDate,
  };

  const keys      = Object.keys(hdrs).sort();
  const canonHdrs = keys.map(k => `${k}:${hdrs[k]}`).join('\n') + '\n';
  const signedH   = keys.join(';');
  const credScope = `${dateStamp}/auto/s3/aws4_request`;

  const canonReq  = ['PUT', `/${R2_BUCKET}/${r2Key}`, '', canonHdrs, signedH, payHash].join('\n');
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');

  const kDate    = sign(Buffer.from('AWS4' + R2_SECRET_KEY), dateStamp, true);
  const kRegion  = sign(kDate, 'auto', true);
  const kService = sign(kRegion, 's3', true);
  const kSigning = sign(kService, 'aws4_request', true);
  const sig      = sign(kSigning, strToSign);

  const auth = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credScope}, SignedHeaders=${signedH}, Signature=${sig}`;

  const resp = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${r2Key}`, {
    method: 'PUT',
    body:   fileBytes,
    headers: {
      'Authorization': auth, 'Content-Type': contentType,
      'Host': host, 'x-amz-content-sha256': payHash,
      'x-amz-date': amzDate, 'Content-Length': String(fileBytes.length),
    }
  });

  if (resp.status !== 200 && resp.status !== 201) {
    const txt = await resp.text();
    throw new Error(`R2 upload failed: ${resp.status} - ${txt}`);
  }
  return `${CDN_BASE}/${r2Key}`;
}

async function downloadFile(url, dest) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'LaughClip-Mixer/1.0' },
    timeout: 60000,
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} for ${url}`);
  const buf = await resp.buffer();
  fs.writeFileSync(dest, buf);
}

async function generateThumbForVideo(videoUrl) {
  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_v.mp4`);
  const thumbPath = path.join(tmpDir, `${id}_thumb.jpg`);

  try {
    await downloadFile(videoUrl, videoPath);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['00:00:01'],
          filename:   path.basename(thumbPath),
          folder:     tmpDir,
          size:       '360x640',
        })
        .on('end', resolve)
        .on('error', reject);
    });

    const videoKey = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key    = videoKey.replace(/\.mp4$/, '_thumb.jpg');
    const thumbUrl = await uploadToR2(thumbPath, r2Key, 'image/jpeg');

    [videoPath, thumbPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return thumbUrl;
  } catch (err) {
    [videoPath, thumbPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    throw err;
  }
}

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'laughclip-mixer', firebaseReady: !!db, time: new Date().toISOString() });
});

// POST /mix
app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl, volume = 0.8 } = req.body;
  console.log('[MIX] Request:', { videoUrl, audioUrl, volume });

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }

  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_v.mp4`);
  const audioPath = path.join(tmpDir, `${id}_a.mp4`);
  const outPath   = path.join(tmpDir, `${id}_out.mp4`);

  try {
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          `[0:a]volume=0.3[va]`,
          `[1:a]volume=${volume},apad[sa]`,
          `[va][sa]amix=inputs=2:duration=first:dropout_transition=2[aout]`
        ])
        .outputOptions([
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-shortest',
          '-movflags', '+faststart',
        ])
        .output(outPath)
        .on('start', cmd => console.log('[FFmpeg]', cmd))
        .on('end', () => { resolve(); })
        .on('error', (err) => { reject(err); })
        .run();
    });

    const videoKey  = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key     = videoKey.replace(/\.mp4$/, `_mix_${id.slice(0,8)}.mp4`);
    const mixedUrl  = await uploadToR2(outPath, r2Key);

    [videoPath, audioPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

    return res.json({ status: 'success', mixedUrl });

  } catch (err) {
    console.error('[MIX] Error:', err.message);
    [videoPath, audioPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return res.status(500).json({ error: err.message });
  }
});

// POST /thumbnail
app.post('/thumbnail', async (req, res) => {
  const { videoUrl } = req.body;
  console.log('[THUMB] Request:', videoUrl);
  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  try {
    const thumbUrl = await generateThumbForVideo(videoUrl);
    console.log('[THUMB] Done:', thumbUrl);
    return res.json({ status: 'success', thumbUrl });
  } catch (err) {
    console.error('[THUMB] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /compress
app.post('/compress', async (req, res) => {
  const { videoUrl, outputKey } = req.body;
  console.log('[COMPRESS] Request:', videoUrl);

  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  const tmpDir     = os.tmpdir();
  const id         = uuidv4();
  const inputPath  = path.join(tmpDir, `${id}_input.mp4`);
  const outputPath = path.join(tmpDir, `${id}_compressed.mp4`);

  try {
    await downloadFile(videoUrl, inputPath);
    const originalSize = fs.statSync(inputPath).size;

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-vf', 'scale=720:-2',
          '-crf', '26',
          '-preset', 'fast',
          '-b:v', '1500k',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-r', '30',
          '-g', '60',
          '-sc_threshold', '0',
        ])
        .output(outputPath)
        .on('start', cmd => console.log('[FFmpeg compress]', cmd))
        .on('end', () => { resolve(); })
        .on('error', err => { reject(err); })
        .run();
    });

    const compressedSize = fs.statSync(outputPath).size;
    const reduction = (((originalSize - compressedSize) / originalSize) * 100).toFixed(1);

    const videoKey  = videoUrl.replace(CDN_BASE + '/', '');
    const r2Key     = outputKey || videoKey.replace(/\.mp4$/, '_hq.mp4');
    const compressedUrl = await uploadToR2(outputPath, r2Key);

    [inputPath, outputPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

    // Delete original from R2 to save storage space
    if (videoKey !== r2Key) {
      try {
        // reuse deleteFromR2 logic inline (simple HEAD/DELETE via same sig scheme)
        await deleteFromR2(videoKey);
      } catch (e) {
        console.warn('[COMPRESS] Could not delete original:', e.message);
      }
    }

    return res.json({
      status: 'success', compressedUrl, originalSize, compressedSize,
      reduction: `${reduction}%`,
    });

  } catch (err) {
    console.error('[COMPRESS] Error:', err.message);
    [inputPath, outputPath].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    return res.status(500).json({ error: err.message });
  }
});

async function deleteFromR2(r2Key) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 16) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host      = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const payHash   = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const hdrs = { 'host': host, 'x-amz-content-sha256': payHash, 'x-amz-date': amzDate };
  const keys      = Object.keys(hdrs).sort();
  const canonHdrs = keys.map(k => `${k}:${hdrs[k]}`).join('\n') + '\n';
  const signedH   = keys.join(';');
  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const canonReq  = ['DELETE', `/${R2_BUCKET}/${r2Key}`, '', canonHdrs, signedH, payHash].join('\n');
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const kDate    = sign(Buffer.from('AWS4' + R2_SECRET_KEY), dateStamp, true);
  const kRegion  = sign(kDate, 'auto', true);
  const kService = sign(kRegion, 's3', true);
  const kSigning = sign(kService, 'aws4_request', true);
  const sig      = sign(kSigning, strToSign);
  const auth = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credScope}, SignedHeaders=${signedH}, Signature=${sig}`;

  const resp = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${r2Key}`, {
    method: 'DELETE',
    headers: { 'Authorization': auth, 'Host': host, 'x-amz-content-sha256': payHash, 'x-amz-date': amzDate }
  });
  console.log(`[R2 DELETE] ${r2Key} -> ${resp.status}`);
  return resp.status === 204 || resp.status === 200;
}

// ── POST /backfill-thumbnails ────────────────────────────────────────────
// One-time job: scan ALL clips missing thumbnailUrl, generate + save them.
// Call with ?limit=N to control batch size (default 20), ?dryRun=true to just count.
app.post('/backfill-thumbnails', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialized — set FIREBASE_SERVICE_ACCOUNT env var' });

  const limit  = parseInt(req.query.limit || '20', 10);
  const dryRun = req.query.dryRun === 'true';

  try {
    const snapshot = await db.collection('clips').get();
    const missing = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if ((!data.thumbnailUrl || data.thumbnailUrl === '') && data.url) {
        missing.push({ id: doc.id, url: data.url });
      }
    });

    console.log(`[BACKFILL] Found ${missing.length} clips missing thumbnails (total clips: ${snapshot.size})`);

    if (dryRun) {
      return res.json({ status: 'dry-run', totalClips: snapshot.size, missingThumbnails: missing.length });
    }

    const batch = missing.slice(0, limit);
    const results = [];

    for (const clip of batch) {
      try {
        const thumbUrl = await generateThumbForVideo(clip.url);
        await db.collection('clips').doc(clip.id).update({ thumbnailUrl: thumbUrl });
        results.push({ id: clip.id, status: 'ok', thumbUrl });
        console.log(`[BACKFILL] ✅ ${clip.id} -> ${thumbUrl}`);
      } catch (e) {
        results.push({ id: clip.id, status: 'failed', error: e.message });
        console.error(`[BACKFILL] ❌ ${clip.id}: ${e.message}`);
      }
    }

    return res.json({
      status: 'done',
      totalClips: snapshot.size,
      totalMissing: missing.length,
      processedThisRun: batch.length,
      remaining: missing.length - batch.length,
      results,
    });

  } catch (err) {
    console.error('[BACKFILL] Fatal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LaughClip Mixer running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
