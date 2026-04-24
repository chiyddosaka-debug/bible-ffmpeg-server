const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
app.use(express.json({ limit: '2mb' }));

const TMP = '/tmp/bible';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function download(url, dest) {
    return new Promise((resolve, reject) => {
          const file = fs.createWriteStream(dest);
          const client = url.startsWith('https') ? https : http;
          client.get(url, (res) => {
                  if (res.statusCode === 301 || res.statusCode === 302) {
                            file.close();
                            return download(res.headers.location, dest).then(resolve).catch(reject);
                  }
                  res.pipe(file);
                  file.on('finish', () => file.close(resolve));
          }).on('error', (err) => {
                  fs.unlink(dest, () => {});
                  reject(err);
          });
    });
}

async function synthesizeTTS(text, outPath, voice) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
          voice || 'en-US-GuyNeural',
          OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
        );
    return new Promise((resolve, reject) => {
          const result = tts.toStream(text);
          const writable = fs.createWriteStream(outPath);
          result.audioStream.pipe(writable);
          result.audioStream.on('end', () => {
                  writable.close(() => resolve());
          });
          result.audioStream.on('error', reject);
          writable.on('error', reject);
    });
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Bible FFmpeg Merge Server' });
});

app.post('/merge', async (req, res) => {
    const { imageUrl, audioUrl, text, voice } = req.body;

           if (!imageUrl || (!audioUrl && !text)) {
                 return res.status(400).json({ error: 'imageUrl and (audioUrl or text) are required' });
           }

           const id = Date.now();
    const imagePath = path.join(TMP, `${id}_image.jpg`);
    const audioPath = path.join(TMP, `${id}_audio.mp3`);
    const outputPath = path.join(TMP, `${id}_output.mp4`);

           try {
                 console.log(`[${id}] Downloading image: ${imageUrl}`);
                 await download(imageUrl, imagePath);

      if (text) {
              console.log(`[${id}] Synthesizing TTS (${text.length} chars)`);
              await synthesizeTTS(text, audioPath, voice);
      } else {
              console.log(`[${id}] Downloading audio: ${audioUrl}`);
              await download(audioUrl, audioPath);
      }

      console.log(`[${id}] Merging with FFmpeg...`);

      const probeOut = execSync(
              `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
            ).toString().trim();
                 const duration = parseFloat(probeOut) || 60;

      console.log(`[${id}] Audio duration: ${duration}s`);

      execSync(
              `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" ` +
              `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
              `-c:v libx264 -tune stillimage -c:a aac -b:a 192k ` +
              `-shortest -t ${duration} -pix_fmt yuv420p "${outputPath}"`,
        { timeout: 180000 }
            );

      console.log(`[${id}] Done! Sending video...`);

      res.setHeader('Content-Type', 'video/mp4');
                 res.setHeader('Content-Disposition', `attachment; filename="bible_short_${id}.mp4"`);

      const stream = fs.createReadStream(outputPath);
                 stream.pipe(res);
                 stream.on('end', () => {
                         [imagePath, audioPath, outputPath].forEach(f => {
                                   try { fs.unlinkSync(f); } catch {}
                         });
                 });

           } catch (err) {
                 console.error(`[${id}] Error:`, err.message);
                 [imagePath, audioPath, outputPath].forEach(f => {
                         try { fs.unlinkSync(f); } catch {}
                 });
                 res.status(500).json({ error: err.message });
           }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bible FFmpeg server running on port ${PORT}`);
});
