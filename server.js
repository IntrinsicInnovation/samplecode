'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.songsterr.com/',
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Constants ─────────────────────────────────────────────────────────────────
const NOTE_NAMES   = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const STR_NAMES    = ['e','B','G','D','A','E'];   // 0=high e, 5=low E
const STANDARD     = [64,59,55,50,45,40];
const DISPLAY_COLS = 8;
const STAGE_HOSTS = ['d3d3l6a6rcgkaf','dqsljvtekg760','d34shlm8p2ums2','d3cqchs6g3b5ew'];

// Duration: Songsterr uses [numerator, denominator] fraction of whole note
// e.g. [1,4]=quarter, [1,8]=eighth, [1,16]=sixteenth
// Also handles legacy string format just in case
function durFraction(dur) {
  if (Array.isArray(dur) && dur.length === 2) return dur[0] / dur[1];
  const map = { whole:1, half:0.5, quarter:0.25, eighth:0.125, sixteenth:0.0625,
    thirty_second:0.03125, w:1, h:0.5, q:0.25, e:0.125, s:0.0625, t:0.03125,
    1:1, 2:0.5, 4:0.25, 8:0.125, 16:0.0625, 32:0.03125 };
  const key = String(dur).toLowerCase().replace(/-/g,'_');
  return map[key] ?? map[dur] ?? 0.25;
}

// ── Search ────────────────────────────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL   = 10 * 60 * 1000;

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.results);
  try {
    const r = await fetch(`https://www.songsterr.com/api/search?pattern=${encodeURIComponent(q)}`, { headers: BROWSER_HEADERS });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    const results = Array.isArray(data.records)
      ? data.records.slice(0, 12).map(rec => ({ songId: rec.songId, title: rec.title || 'Unknown', artist: rec.artist || '' }))
      : [];
    searchCache.set(cacheKey, { results, ts: Date.now() });
    return res.json(results);
  } catch (err) {
    console.error('Search error:', err.message);
    return res.json([]);
  }
});

// ── Debug endpoint ────────────────────────────────────────────────────────────
app.get('/api/debug/:songId', async (req, res) => {
  try {
    const { songId } = req.params;
    const meta = await fetchJson(`https://www.songsterr.com/api/meta/${songId}`);
    const revisionId = meta.revisionId || meta.defaultRevision?.revisionId;
    const image      = meta.image      || meta.defaultRevision?.image;
    const tracks     = meta.tracks     || meta.defaultRevision?.tracks || [];

    const stageTried = [];
    for (let i = 0; i < tracks.length; i++) {
      const d = await fetchStage(songId, revisionId, image, i);
      const hasNotes = d?.measures?.some(m => m.voices?.some(v => v.beats?.some(b => b.notes?.length > 0)));
      stageTried.push({ index: i, name: tracks[i].name, measureCount: d?.measures?.length ?? 0, hasNotes, firstBeat: d?.measures?.[0]?.voices?.[0]?.beats?.[0] ?? null });
    }
    res.json({ title: meta.title, artist: meta.artist, revisionId, image, trackCount: tracks.length, stageTried });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tab fetch ─────────────────────────────────────────────────────────────────
app.get('/api/tab/:songId', async (req, res) => {
  const { songId } = req.params;
  if (!songId || isNaN(songId)) return res.status(400).json({ error: 'Invalid song ID' });

  try {
    // Step 1: Fetch meta (fast, always works)
    const meta = await fetchJson(`https://www.songsterr.com/api/meta/${songId}`);
    const revisionId = meta.revisionId || meta.defaultRevision?.revisionId;
    const image      = meta.image      || meta.defaultRevision?.image;
    const tracks     = meta.tracks     || meta.defaultRevision?.tracks || [];

    console.log(`[tab/${songId}] "${meta.title}" by "${meta.artist}" | rev=${revisionId} | image=${image} | ${tracks.length} tracks`);

    // Extract YouTube video ID from meta.videos
    // Priority: feature=null (official MV) > backing > alternative > any
    let youtubeId = null;
    const vids = Array.isArray(meta.videos) ? meta.videos.filter(v => v.status === 'done' && v.videoId) : [];
    const priorities = [
      vids.find(v => v.feature === null),
      vids.find(v => v.feature === 'backing'),
      vids.find(v => v.feature === 'alternative'),
      vids[0],
    ];
    const chosen = priorities.find(Boolean);
    if (chosen) youtubeId = chosen.videoId;

    if (!revisionId || !image) {
      return res.status(404).json({ error: 'Missing revision or image data from Songsterr.' });
    }

    // Step 2: Get time signature (always 4/4 in practice, stored in measure.signature)
    // Tempo is NOT in the Songsterr API — we extract it from the audioV4 MIDI metadata
    let tempo = 0;
    let tsNum = 4;
    // Try the audioV4 meta endpoint which sometimes has BPM
    const audioHash = meta.audioV4 || meta.audioV4Midi;
    if (audioHash) {
      try {
        const audioMeta = await fetchJson(`https://www.songsterr.com/api/audio/${audioHash}/meta`);
        if (audioMeta?.bpm > 20) tempo = audioMeta.bpm;
        if (audioMeta?.tempo > 20) tempo = audioMeta.tempo;
        if (audioMeta?.timeSignature?.numerator) tsNum = audioMeta.timeSignature.numerator;
      } catch(_) {}
    }
    if (!tempo || tempo < 20) tempo = 120; // fallback

    // Step 3: Try all track indices, in guitar-priority order, grab first with real notes
    const order = buildTrackOrder(tracks);
    let stageData = null;
    let usedIndex = -1;

    for (const i of order) {
      const data = await fetchStage(songId, revisionId, image, i);
      if (!data?.measures?.length) continue;
      // Verify it actually has notes (not just empty beats)
      const hasNotes = data.measures.some(m =>
        m.voices?.some(v => v.beats?.some(b => b.notes?.length > 0))
      );
      if (hasNotes) { stageData = data; usedIndex = i; break; }
      // Accept it anyway if nothing better found (store as fallback)
      if (!stageData) { stageData = data; usedIndex = i; }
    }

    if (!stageData) {
      return res.status(404).json({
        error: `Tab data not available for "${meta.title}". Try uploading a .gpx file from Ultimate Guitar instead.`
      });
    }

    const usedTrack  = tracks[usedIndex];
    const tuningMidi = stageData.tuning || usedTrack?.tuning || STANDARD;
    const capo       = stageData.capo   || usedTrack?.capo   || 0;
    const measures   = parseMeasures(stageData.measures, tsNum);

    // Extract time signature from measure[0].signature = [4,4]
    const sig = stageData.measures?.[0]?.signature;
    if (Array.isArray(sig) && sig[0]) tsNum = sig[0];
    // anacrusis = pickup/intro beats before measure 1 (in ticks, 480 ticks/beat)
    const anacrusis = stageData.anacrusis || 0;
    const ticksPerBeat = 480;
    const ytStartOffset = anacrusis > 0 ? (anacrusis / ticksPerBeat) * (60 / tempo) : 0;
    // Read BPM from automations.tempo (where Songsterr actually stores it)
    const tempoAuto = stageData.automations?.tempo;
    if (Array.isArray(tempoAuto) && tempoAuto.length > 0 && tempoAuto[0].bpm > 20) {
      tempo = tempoAuto[0].bpm;
      console.log(`[tab] BPM from automations: ${tempo}`);
    } else if (stageData.tempo > 20) {
      tempo = stageData.tempo;
    }
    console.log(`[tab/${songId}] ✓ ${measures.length} measures | track[${usedIndex}]="${usedTrack?.name}" | ${tempo} BPM | ${tsNum}/4`);

    return res.json({
      title:         meta.title  || 'Unknown',
      artist:        meta.artist || '',
      tuning:        tuningToName(tuningMidi),
      bpm:           tempo || 120,
      bpmIsEstimate: !tempo || tempo === 120,
      ytStartOffset,   // seconds before measure 1 in the audio (from anacrusis)
      capo,
      timeSignature: `${tsNum}/4`,
      difficulty:    'Sourced from Songsterr',
      notes:         `Track: "${usedTrack?.name || 'Guitar'}". Tab from Songsterr.`,
      youtubeId,
      measures,
    });

  } catch (err) {
    console.error(`[tab/${songId}] Error:`, err.stack);
    return res.status(500).json({ error: err.message });
  }
});

// ── Core parser ───────────────────────────────────────────────────────────────
function parseMeasures(rawMeasures, tsNumerator = 4) {
  const LABELS = { 0:'Intro', 8:'Verse', 16:'Chorus', 24:'Bridge', 32:'Solo', 40:'Outro' };
  const measureLen = tsNumerator / 4;
  // Extract tempo from first measure marker (Songsterr stores BPM there)
  // marker can be { tempo: 144 } or { name: "q=144" } or { tempo: { value: 144 } }
  let extractedTempo = 0;
  for (const m of rawMeasures) {
    if (!m.marker) continue;
    const mk = m.marker;
    if (mk.tempo && typeof mk.tempo === 'number') { extractedTempo = mk.tempo; break; }
    if (mk.tempo?.value) { extractedTempo = mk.tempo.value; break; }
    if (mk.value && typeof mk.value === 'number') { extractedTempo = mk.value; break; }
    // Parse "q=144" or "♩=144" style
    const match = JSON.stringify(mk).match(/[=:]\s*(\d{2,3})/);
    if (match) { extractedTempo = parseInt(match[1]); break; }
  }
  // Store on array for caller to read
  rawMeasures._extractedTempo = extractedTempo;

  return rawMeasures.map((measure, mi) => {
    const strings = {};
    STR_NAMES.forEach(s => { strings[s] = Array(DISPLAY_COLS).fill('-'); });

    // Pass 1: collect all note events with their exact position (0..1 through measure)
    // events are also stored raw for accurate audio scheduling (bypasses display grid)
    const events = []; // { measurePos, strIdx, fret }

    for (const voice of (measure.voices || [])) {
      let pos = 0; // accumulates in whole-note units

      for (const beat of (voice.beats || [])) {
        const frac      = durFraction(beat.duration ?? beat.Duration ?? [1,4]);
        const dotFrac   = beat.dotted ? frac * 0.5 : 0;
        const totalFrac = frac + dotFrac;
        const measurePos = pos / measureLen; // 0..1 fraction through this measure

        for (const note of (beat.notes || [])) {
          const fret   = note.fret ?? note.value ?? note.Value;
          const strIdx = note.string ?? note.String;
          // Skip invalid, drums (fractional string indices)
          if (fret == null || strIdx == null || !Number.isInteger(strIdx)) continue;
          // Songsterr uses 1-based string index: 1=high e, 2=B, 3=G, 4=D, 5=A, 6=low E
          const displayIdx = strIdx;  // 1=B,2=G,3=D,4=A,5=E,6=? maps to STR_NAMES directly
          if (displayIdx < 0 || displayIdx > 5) continue;
          events.push({ measurePos, strIdx: displayIdx, fret: String(fret) });
        }

        pos += totalFrac;
      }
    }

    // Pass 2: quantize positions → display columns
    // Strategy: round to nearest column, but if two notes want the same column,
    // the one with an earlier position wins (first-note-wins per cell per string).
    // We sort by position first so earlier beats always place first.
    events.sort((a, b) => a.measurePos - b.measurePos);

    for (const { measurePos, strIdx, fret } of events) {
      const col = Math.min(Math.round(measurePos * DISPLAY_COLS), DISPLAY_COLS - 1);
      const strName = STR_NAMES[strIdx];
      if (strings[strName][col] === '-') {
        strings[strName][col] = fret;
      } else {
        // Column taken — try adjacent columns (prefer right, then left)
        const next = col + 1 < DISPLAY_COLS ? col + 1 : -1;
        const prev = col - 1 >= 0 ? col - 1 : -1;
        if (next !== -1 && strings[strName][next] === '-') strings[strName][next] = fret;
        else if (prev !== -1 && strings[strName][prev] === '-') strings[strName][prev] = fret;
        // else: drop the note — measure is too dense for 8-column display
      }
    }

    return { number: mi + 1, label: LABELS[mi] ?? null, strings, events };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchJson(url) {
  const r = await fetch(url, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} → ${url}`);
  return r.json();
}

async function fetchStage(songId, revisionId, image, index) {
  if (index == null || !revisionId || !image) return null;
  const referer = `https://www.songsterr.com/a/wsa/-tab-s${songId}`;
  const headers = { ...BROWSER_HEADERS, Accept: 'application/json', Referer: referer };
  // Try every host — different songs are gated to different CloudFront distributions
  for (const host of STAGE_HOSTS) {
    const url = `https://${host}.cloudfront.net/${songId}/${revisionId}/${image}/${index}.json`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.measures?.length) {
        console.log(`[stage] host=${host} index=${index} measures=${data.measures.length}`);
        return data;
      }
    } catch (e) {
      // network error on this host, try next
    }
  }
  console.warn(`[stage] all hosts 403/empty for index=${index}`);
  return null;
}

// Build probe order: guitar tracks first (by instrument name priority), then everything else
// This ensures we don't waste time on drums/vocals when a guitar track exists
function buildTrackOrder(tracks) {
  const scored = tracks.map((t, i) => {
    const name = (t.instrument || t.name || '').toLowerCase();
    const empty = t.isEmpty === true;
    let score = 0;
    if (empty) return { i, score: -999 }; // skip empty tracks
    if (/vocal|drum|percussion|clap/i.test(name)) score -= 100;
    if (/bass/i.test(name)) score -= 10;
    if (/piano|key|organ|synth/i.test(name)) score -= 5;
    if (/guitar/i.test(name)) score += 50;
    if (/electric.?guitar|overdrive|distort/i.test(name)) score += 20;
    if (/lead/i.test(t.name || '')) score += 10;
    if (/rhythm/i.test(t.name || '')) score += 5;
    // Prefer tracks with more views (popularity signal)
    if (t.views) score += Math.min(t.views / 10000, 10);
    return { i, score };
  });
  return scored.sort((a, b) => b.score - a.score).map(x => x.i);
}

function tuningToName(arr) {
  if (!arr?.length) return 'Standard (EADGBe)';
  if (JSON.stringify([...arr]) === JSON.stringify(STANDARD)) return 'Standard (EADGBe)';
  return [...arr].reverse().map(m => NOTE_NAMES[((m % 12) + 12) % 12]).join('') + ' tuning';
}

// ── AI Coach ──────────────────────────────────────────────────────────────────
async function callAI(system, user, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY in .env');
  const model = process.env.AI_MODEL || 'openrouter/free';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Stringr' },
    body: JSON.stringify({ model, max_tokens: maxTokens,
      messages: [{ role:'system', content:system }, { role:'user', content:user }] }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message || JSON.stringify(data));
  return data.choices?.[0]?.message?.content?.trim() || '';
}

app.post('/api/analyze-playing', async (req, res) => {
  const {
    songTitle, artist, bpm, barRange,
    noteEvents = [], missedNotes = [], expectedTimeline = [],
    avgTimingOffsetMs = 0, timingTendency = '', detectedTechniques = [],
    totalDurationMs,
    expectedNotes = [], detectedNotes = [],
  } = req.body;

  const hasRichData = noteEvents.length > 0 || missedNotes.length > 0;
  const exp = expectedTimeline.length ? expectedTimeline : expectedNotes;
  if (!exp.length && !detectedNotes.length)
    return res.status(400).json({ error: 'Missing note data.' });

  // Build readable per-note breakdown for the LLM
  const lines = [];
  (noteEvents).forEach(ev => {
    if (!ev.expectedNote) return;
    const timing = ev.timingOffsetMs === null ? 'timing unknown'
      : Math.abs(ev.timingOffsetMs) < 20  ? 'right on time'
      : ev.timingOffsetMs > 0             ? `${ev.timingOffsetMs}ms late`
      :                                     `${Math.abs(ev.timingOffsetMs)}ms early`;
    const pitch = Math.abs(ev.centsDeviation || 0) < 12 ? 'pitch accurate'
      : ev.centsDeviation > 0 ? `${ev.centsDeviation} cents sharp`
      :                         `${Math.abs(ev.centsDeviation)} cents flat`;
    const tech = ev.detectedTechnique && ev.detectedTechnique !== 'normal'
      ? ` | technique: ${ev.detectedTechnique}` : '';
    const match = ev.detectedNote === ev.expectedNote
      ? '✓' : `✗ played ${ev.detectedNote}, expected ${ev.expectedNote}`;
    const ref = ev.measure
      ? `Bar ${ev.measure} beat ${ev.beat} (${ev.string || '?'} string fret ${ev.fret || '?'})`
      : ev.expectedNote;
    lines.push(`  ${ref}: ${match}, ${timing}, ${pitch}${tech}`);
  });
  (missedNotes).forEach(ev => {
    lines.push(`  Bar ${ev.measure} beat ${ev.beat} (${ev.string} fret ${ev.fret}): ✗ MISSED — ${ev.noteName} not played`);
  });

  const totalExp   = exp.length || 1;
  const played     = noteEvents.filter(e => e.expectedNote).length;
  const missed     = missedNotes.length;
  const avgMs      = Math.round(avgTimingOffsetMs || 0);
  const tendency   = timingTendency || (avgMs > 15 ? 'rushing (ahead of the beat)' : avgMs < -15 ? 'dragging (behind the beat)' : 'generally on time');
  const techniques = detectedTechniques.join(', ') || 'none detected';

  const system = `You are an experienced guitar teacher specialising in rock and blues lead guitar. \
You just watched a student play a section of a song and you have precise note-by-note data. \
Give feedback exactly as a real guitar teacher would say it out loud — specific, warm, direct, and actionable. \
Reference exact bar and beat numbers and string/fret positions from the data when relevant. \
Use natural musical language: rushing, dragging, sharp, flat, cents, bending, vibrato, feel, groove. \
4–6 sentences max. Start with something positive. Do NOT say "based on the data" — speak naturally as if you just heard them play.`;

  const user = `The student just played bars ${barRange[0]}–${barRange[1]} of "${songTitle}" by ${artist} at ${bpm} BPM.

SUMMARY:
- Notes hit correctly: ${played - missed} / ${totalExp}
- Notes missed entirely: ${missed}
- Average timing offset: ${avgMs}ms (${tendency})
- Techniques heard: ${techniques}

NOTE-BY-NOTE:
${lines.slice(0, 28).join('\n') || '  (basic mode — no per-note breakdown available)'}

Give specific actionable feedback. Name exact bars/beats where timing slips. Call out flat or sharp notes by string/fret. \
Comment on any technique (bend speed, vibrato width, slides). End with ONE clear focus for the next attempt.`;

  try {
    return res.json({ feedback: await callAI(system, user, 600) });
  } catch (err) {
    console.error('AI coach error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Sample tab ────────────────────────────────────────────────────────────────
// Serve pre-processed local tab files (overrides live Songsterr fetch)
app.get('/api/tab/local/:filename', (req, res) => {
  const file = path.join(__dirname, 'public', 'tabs', req.params.filename);
  if (require('fs').existsSync(file)) return res.sendFile(file);
  res.status(404).json({ error: 'Local tab not found' });
});

app.get('/api/sample', (_req, res) => {
  res.json({
    title:'Blues Rock Riff', artist:'Sample', tuning:'Standard (EADGBe)',
    bpm:90, capo:0, timeSignature:'4/4', difficulty:'Beginner',
    notes:'A made-up blues riff to test playback and practice mode.',
    measures:[
      {number:1,label:'Intro', strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['-','-','-','-','-','-','-','-'],A:['-','-','-','-','-','-','-','-'],E:['0','-','0','-','3','-','0','-']}},
      {number:2,label:null,   strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['-','-','-','-','-','-','-','-'],A:['-','-','-','-','-','-','-','-'],E:['0','-','3','-','5','-','3','-']}},
      {number:3,label:'Verse',strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['-','-','-','-','-','-','-','-'],A:['0','-','0','-','3','-','0','-'],E:['-','-','-','-','-','-','-','-']}},
      {number:4,label:null,   strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['-','-','-','-','-','-','-','-'],A:['0','-','3','-','5','-','3','-'],E:['-','-','-','-','-','-','-','-']}},
      {number:5,label:'Chorus',strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['0','-','2','-','0','-','-','-'],A:['2','-','-','-','-','-','2','-'],E:['-','-','-','-','-','-','-','-']}},
      {number:6,label:null,   strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['-','-','-','-','-','-','-','-'],D:['2','-','0','-','2','-','0','-'],A:['0','-','-','-','0','-','-','-'],E:['-','-','-','-','-','-','-','-']}},
      {number:7,label:'Solo', strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['0','-','2','-','4','-','2','-'],D:['-','-','-','-','-','-','-','-'],A:['-','-','-','-','-','-','-','-'],E:['-','-','-','-','-','-','-','-']}},
      {number:8,label:null,   strings:{e:['-','-','-','-','-','-','-','-'],B:['-','-','-','-','-','-','-','-'],G:['4','-','2','-','0','-','-','-'],D:['2','-','-','-','-','-','0','-'],A:['-','-','-','-','-','-','-','-'],E:['-','-','-','-','-','-','-','-']}},
    ]
  });
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Stringr running at http://localhost:${PORT}`);
  console.log(`AI model: ${process.env.AI_MODEL || 'openrouter/free'}`);
});
