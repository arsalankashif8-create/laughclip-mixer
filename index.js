const express  = require('express');
const fetch    = require('node-fetch');
const ffmpeg   = require('fluent-ffmpeg');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { v4: uuidv4 } = require('uuid');

const app  = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// R2 config
const R2_ACCOUNT_ID = 'e8409ad0379b3627b71fdab04c341444';
const R2_ACCESS_KEY = 'cc425bd21cd519d216183baf7ef11327';
const R2_SECRET_KEY = 'c744e387a602669921334bf3c62c7d724e859c86ceb7fa1a9d61b1a864de5287';
const R2_BUCKET     = 'laugh';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const CDN_BASE      = 'https://cdn.laughclip.online';

// ── AWS Signature V4 for R2 ────────────────────────────────────────────────
const crypto = require('crypto');

function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function getSignatureKey(key, dateStamp, region, service) {
  const kDate    = sign('AWS4' + key, dateStamp);
  const kRegion  = sign(kDate, region);
  const kService = sign(kRegion, service);
  return sign(kService, 'aws4_request');
}

async function uploadToR2(filePath, r2Key, contentType = 'video/mp4') {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 16) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host      = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const fileBytes = fs.readFileSync(filePath);
  const payHash   = crypto.createHash('sha256').update(fileBytes).digest('hex');

  const headers = {
    'content-type':         contentType,
    'host':                 host,
    'x-amz-content-sha256': payHash,
    'x-amz-date':           amzDate,
  };

  const sortedKeys  = Object.keys(headers).sort();
  const canonHdrs   = sortedKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHdrs  = sortedKeys.join(';');

  const canonReq = [
    'PUT', `/${R2_BUCKET}/${r2Key}`, '',
    canonHdrs, signedHdrs, payHash
  ].join('\n');

  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');

  const sigKey  = getSignatureKey(R2_SECRET_KEY, dateStamp, 'auto', 's3');
  const sig     = crypto.createHmac('sha256', sigKey).update(strToSign).digest('hex');
  const authHdr = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHdrs}, Signature=${sig}`;

  const resp = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${r2Key}`, {
    method: 'PUT',
    body:   fileBytes,
    headers: {
      'Authorization':        authHdr,
      'Content-Type':         contentType,
      'Host':                 host,
      'x-amz-content-sha256': payHash,
      'x-amz-date':           amzDate,
      'Content-Length':       fileBytes.length,
    }
  });

  if (resp.status !== 200 && resp.status !== 201) {
    const txt = await resp.text();
    throw new Error(`R2 upload failed: ${resp.status} ${txt}`);
  }
  return `${CDN_BASE}/${r2Key}`;
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'laughclip-mixer' });
});

// ── POST /mix ──────────────────────────────────────────────────────────────
// Body: { videoUrl, audioUrl, volume (0-1), outputKey }
app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl, volume = 0.8, outputKey } = req.body;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }

  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_video.mp4`);
  const audioPath = path.join(tmpDir, `${id}_audio.mp4`);
  const outPath   = path.join(tmpDir, `${id}_mixed.mp4`);

  try {
    // Download video
    console.log('Downloading video:', videoUrl);
    const vResp = await fetch(videoUrl);
    if (!vResp.ok) throw new Error('Cannot fetch video');
    fs.writeFileSync(videoPath, Buffer.from(await vResp.arrayBuffer()));

    // Download audio
    console.log('Downloading audio:', audioUrl);
    const aResp = await fetch(audioUrl);
    if (!aResp.ok) throw new Error('Cannot fetch audio');
    fs.writeFileSync(audioPath, Buffer.from(await aResp.arrayBuffer()));

    // Mix with FFmpeg
    console.log('Mixing with FFmpeg...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          // Original video audio at 30% + sound at volume%
          `[0:a]volume=0.3[va]`,
          `[1:a]volume=${volume}[sa]`,
          `[va][sa]amix=inputs=2:duration=first:dropout_transition=2[aout]`
        ])
        .outputOptions([
          '-map', '0:v',       // video from input 0
          '-map', '[aout]',    // mixed audio
          '-c:v', 'copy',      // copy video (fast, no re-encode)
          '-c:a', 'aac',       // encode audio
          '-b:a', '128k',
          '-shortest',
          '-movflags', '+faststart',
        ])
        .output(outPath)
        .on('start', cmd => console.log('FFmpeg:', cmd))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload mixed video to R2
    const r2Key = outputKey || `mixed/${id}.mp4`;
    console.log('Uploading to R2:', r2Key);
    const mixedUrl = await uploadToR2(outPath, r2Key);

    // Cleanup temp files
    [videoPath, audioPath, outPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });

    console.log('Mix done:', mixedUrl);
    return res.json({ status: 'success', mixedUrl });

  } catch (err) {
    console.error('Mix error:', err.message);
    // Cleanup
    [videoPath, audioPath, outPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /thumbnail ────────────────────────────────────────────────────────
// Body: { videoUrl, outputKey }
app.post('/thumbnail', async (req, res) => {
  const { videoUrl, outputKey } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  const tmpDir    = os.tmpdir();
  const id        = uuidv4();
  const videoPath = path.join(tmpDir, `${id}_video.mp4`);
  const thumbPath = path.join(tmpDir, `${id}_thumb.jpg`);

  try {
    // Download video
    const vResp = await fetch(videoUrl);
    if (!vResp.ok) throw new Error('Cannot fetch video');
    fs.writeFileSync(videoPath, Buffer.from(await vResp.arrayBuffer()));

    // Extract first frame
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['00:00:00.500'],
          filename:   path.basename(thumbPath),
          folder:     tmpDir,
          size:       '360x640',
        })
        .on('end', resolve)
        .on('error', reject);
    });

    // Upload thumbnail to R2
    const r2Key    = outputKey || `thumbnails/${id}_thumb.jpg`;
    const thumbUrl = await uploadToR2(thumbPath, r2Key, 'image/jpeg');

    [videoPath, thumbPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });

    return res.json({ status: 'success', thumbUrl });

  } catch (err) {
    console.error('Thumbnail error:', err.message);
    [videoPath, thumbPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LaughClip Mixer running on port ${PORT}`));
