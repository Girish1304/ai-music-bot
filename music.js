const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  StreamType,
} = require("@discordjs/voice");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const play = require("play-dl");
const { exec } = require("yt-dlp-exec");
const { spawn } = require("child_process");

const queues = new Map();

// ================= CONFIG =================
const PREFETCH_MIN_QUEUE = 2;
const HISTORY_LIMIT = 40;

// ================= QUEUE =================
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    queues.set(guildId, {
      songs: [],
      player,
      playing: false,
      nowPlaying: null,

      autoplay: true,
      lastTitle: null,

      history: [], // played URLs
      historyTitles: [], // played title keys + main song keys

      startedAt: null,
      durationSec: null,

      loopSong: false,
      loopQueue: false,

      mood: "default",

      ui: { channelId: null, messageId: null },
    });

    player.on(AudioPlayerStatus.Idle, async () => {
      const q = queues.get(guildId);
      if (!q) return;

      // Loop current song
      if (q.loopSong && q.nowPlaying) q.songs.unshift(q.nowPlaying);

      // Loop queue
      if (q.loopQueue && q.nowPlaying) q.songs.push(q.nowPlaying);

      q.playing = false;
      q.nowPlaying = null;

      // Play next if queue has songs
      if (q.songs.length > 0) {
        return playNext(guildId).catch(console.error);
      }

      // Autoplay if queue empty
      if (q.autoplay && q.lastTitle) {
        try {
          await ensurePrefetch(guildId);
          if (q.songs.length > 0) {
            return playNext(guildId).catch(console.error);
          }
        } catch (e) {
          console.log("❌ Autoplay error:", e.message);
        }
      }

      await updateNowPlayingMessage(guildId).catch(() => {});
    });

    player.on("error", (err) => {
      console.log("🎵 Player error:", err.message);
    });
  }

  return queues.get(guildId);
}

// ================= STRICT SEARCH =================
// Strict rules:
// ✅ Allow ONLY: Official Music Video / Official Video / Official Audio / Topic
// ❌ Block: reaction, remix, live, cover, interview, shorts etc
async function searchYTStrict(query, limit = 25) {
  try {
    const results = await play.search(query, { limit });
    if (!results.length) return [];

    const BLOCK_WORDS = [
      "reaction", "react", "review", "podcast", "interview", "explained",
      "live", "concert", "performance", "cover", "remix", "slowed",
      "reverb", "nightcore", "edit", "mashup", "vlog", "funny",
      "challenge", "tiktok", "status", "bgm", "scene", "trailer",
      "teaser", "behind the scenes", "making", "karaoke"
    ];

    const ALLOW_WORDS = [
      "official music video",
      "official video",
      "official audio",
      "audio",
      "topic",
    ];

    return results
      .map((r) => {
        const url =
          r.url || (r.id ? `https://www.youtube.com/watch?v=${r.id}` : null);

        return {
          title: r.title,
          url,
          durationInSec: r.durationInSec || null,
        };
      })
      .filter((x) => x.url)
      .filter((x) => !x.url.includes("/shorts/")) // ❌ no shorts
      .filter((x) => {
        const t = (x.title || "").toLowerCase();

        // ❌ block unwanted
        if (BLOCK_WORDS.some((w) => t.includes(w))) return false;

        // ✅ must contain strict allow words
        if (ALLOW_WORDS.some((w) => t.includes(w))) return true;

        return false;
      });
  } catch (err) {
    console.log("⚠️ play-dl search failed:", err.message);
    return [];
  }
}

// ================= TITLE HELPERS =================
function cleanTitle(t = "") {
  return t
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/official|music video|video|lyrics|lyrical|audio|mv|hd|4k/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ Main key to stop same song repeating in different uploads
function getMainSongKey(title = "") {
  let t = title.toLowerCase();

  t = t.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "");
  t = t.replace(/official|music video|video|lyrics|lyrical|audio|full song|song|jukebox/gi, "");
  t = t.replace(/\s+/g, " ").trim();

  // split by separators
  if (t.includes("|")) t = t.split("|")[0].trim();

  // "Artist - Song" -> take song part
  if (t.includes(" - ")) {
    const parts = t.split(" - ");
    if (parts[1]) t = parts[1].trim();
  }

  // take first 4 words as key
  return t.split(" ").slice(0, 4).join(" ").trim();
}

function getArtistFromTitle(title = "") {
  if (title.includes(" - ")) return title.split(" - ")[0].trim();
  return title.split(" ").slice(0, 2).join(" ").trim();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isRepeated(q, song) {
  if (!song || !song.url) return true;

  // same URL already played
  if (q.history.includes(song.url)) return true;

  // same title already played
  const titleKey = cleanTitle(song.title || "").toLowerCase();
  if (q.historyTitles.includes(titleKey)) return true;

  // same MAIN song repeated (fix for Chikitu issue)
  const mainKey = getMainSongKey(song.title || "");
  if (q.historyTitles.includes(mainKey)) return true;

  return false;
}

// ================= SMART AUTOPLAY (STRICT) =================
function buildSmartQueries(lastTitle, mood = "default") {
  const artist = getArtistFromTitle(lastTitle);
  const base = cleanTitle(lastTitle);

  const moodQueries = {
    default: [
      `${artist} official audio`,
      `${artist} official music video`,
      `${artist} topic`,
      `${base} official audio`,
      `${base} official music video`,
    ],
    chill: [
      `${artist} official audio`,
      `${artist} topic`,
      `${base} official audio`,
    ],
    party: [
      `${artist} official music video`,
      `${artist} official audio`,
      `${artist} topic`,
      `${base} official music video`,
    ],
    sad: [
      `${artist} official audio`,
      `${artist} topic`,
      `${base} official audio`,
    ],
    romantic: [
      `${artist} official audio`,
      `${artist} topic`,
      `${base} official audio`,
    ],
    focus: [
      `${artist} topic`,
      `${artist} official audio`,
      `${base} official audio`,
    ],
  };

  const list = moodQueries[mood] || moodQueries.default;
  return list.sort(() => Math.random() - 0.5);
}

async function getSmartAutoPlaySong(guildId) {
  const q = getQueue(guildId);
  if (!q || !q.lastTitle) return null;

  const queries = buildSmartQueries(q.lastTitle, q.mood);

  for (const query of queries) {
    const results = await searchYTStrict(query, 30);
    if (!results.length) continue;

    const filtered = results.filter((s) => !isRepeated(q, s));
    if (filtered.length > 0) {
      const pool = filtered.slice(0, 6);
      return pickRandom(pool);
    }
  }

  return null;
}

async function ensurePrefetch(guildId) {
  const q = getQueue(guildId);
  if (!q) return;

  while (q.songs.length < PREFETCH_MIN_QUEUE && q.autoplay && q.lastTitle) {
    const next = await getSmartAutoPlaySong(guildId);
    if (!next || !next.url) break;
    q.songs.push(next);
  }
}

// ================= STREAMING =================
async function getDirectAudioUrl(videoUrl) {
  const output = await exec(videoUrl, {
    format: "bestaudio",
    getUrl: true,
    noWarnings: true,
    preferFreeFormats: true,
    addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
  });

  return output.stdout.trim();
}

// ================= UI =================
function formatTime(sec = 0) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function makeProgressBar(current, total, size = 18) {
  if (!total || total <= 0) return "🔘 " + "━".repeat(size);

  const ratio = Math.min(1, Math.max(0, current / total));
  const pos = Math.floor(ratio * size);

  let bar = "";
  for (let i = 0; i < size; i++) bar += i === pos ? "🔘" : "━";
  return bar;
}

function getNowPlayingEmbedAndButtons(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.nowPlaying) return null;

  const elapsed = q.startedAt ? (Date.now() - q.startedAt) / 1000 : 0;
  const total = q.durationSec || 0;

  const nextSong = q.songs.length > 0 ? q.songs[0] : null;

  const embed = new EmbedBuilder()
    .setTitle("🎶 Now Playing")
    .setDescription(`**${q.nowPlaying.title}**\n${q.nowPlaying.url}`)
    .addFields(
      {
        name: "Progress",
        value: `${formatTime(elapsed)} ${makeProgressBar(elapsed, total)} ${
          total ? formatTime(total) : "LIVE"
        }`,
      },
      {
        name: "⏭ Up Next",
        value: nextSong ? `**${nextSong.title}**` : "`None (AutoPlay will pick)`",
      },
      {
        name: "🎛 Mood",
        value: `**${q.mood}**`,
        inline: true,
      },
      {
        name: "🤖 AutoPlay",
        value: q.autoplay ? "ON ✅" : "OFF ❌",
        inline: true,
      }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("music_pause").setLabel("Pause").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_resume").setLabel("Resume").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("music_skip").setLabel("Skip").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("music_shuffle").setLabel("Shuffle").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("music_loop_song").setLabel("Loop Song").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_loop_queue").setLabel("Loop Queue").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_autoplay").setLabel("AutoPlay").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function updateNowPlayingMessage(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (!q.ui.channelId || !q.ui.messageId) return;
  if (!q.nowPlaying) return;

  const data = getNowPlayingEmbedAndButtons(guildId);
  if (!data) return;

  try {
    const channel = await global.client.channels.fetch(q.ui.channelId);
    const msg = await channel.messages.fetch(q.ui.messageId);
    await msg.edit(data);
  } catch (e) {
    q.ui.channelId = null;
    q.ui.messageId = null;
  }
}

// ================= PLAYER =================
async function playNext(guildId) {
  const q = getQueue(guildId);
  if (!q) return;

  const song = q.songs.shift();
  if (!song || !song.url) return;

  q.playing = true;
  q.nowPlaying = song;
  q.lastTitle = song.title;

  q.history.push(song.url);
  if (q.history.length > HISTORY_LIMIT) q.history.shift();

  // Store BOTH titleKey + mainKey (prevents duplicates)
  const titleKey = cleanTitle(song.title).toLowerCase();
  const mainKey = getMainSongKey(song.title);

  q.historyTitles.push(titleKey);
  q.historyTitles.push(mainKey);

  if (q.historyTitles.length > HISTORY_LIMIT) q.historyTitles.splice(0, 2);

  q.startedAt = Date.now();
  q.durationSec = song.durationInSec || null;

  console.log("▶ Playing:", song.title);
  console.log("▶ URL:", song.url);

  // prefetch
  ensurePrefetch(guildId).catch(() => {});

  const directUrl = await getDirectAudioUrl(song.url);

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", directUrl,
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  q.player.play(resource);

  await updateNowPlayingMessage(guildId).catch(() => {});
}

// ================= COMMANDS =================
async function handlePlay(interaction, query) {
  if (!interaction.guild) {
    return interaction.reply("❌ This command works only inside a server.");
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply("❌ Join a voice channel first!");
  }

  const guildId = interaction.guild.id;
  const q = getQueue(guildId);

  let connection = getVoiceConnection(guildId);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });
    connection.subscribe(q.player);
  }

  await interaction.deferReply();

  let song;

  // If direct youtube link
  if (play.yt_validate(query) === "video") {
    const info = await play.video_basic_info(query);
    song = {
      title: info.video_details.title,
      url: info.video_details.url,
      durationInSec: Number(info.video_details.durationInSec || 0) || null,
    };
  } else {
    // STRICT search
    const results = await searchYTStrict(query, 30);
    if (!results.length) {
      return interaction.editReply("❌ No **official audio/video/topic** found. Try different name.");
    }
    song = results[0];
  }

  q.songs.push(song);

  if (!q.playing) {
    await playNext(guildId);
  }

  // store message for auto update
  try {
    const replyMsg = await interaction.fetchReply();
    q.ui.channelId = replyMsg.channelId;
    q.ui.messageId = replyMsg.id;
  } catch {}

  const data = getNowPlayingEmbedAndButtons(guildId);
  if (data) {
    try {
      await interaction.editReply(data);
    } catch {}
  }
}

async function handleSkip(interaction) {
  if (!interaction.guild) return interaction.reply("❌ Use inside a server.");
  const q = getQueue(interaction.guild.id);
  q.player.stop();
  return interaction.reply("⏭️ Skipped!");
}

async function handleStop(interaction) {
  if (!interaction.guild) return interaction.reply("❌ Use inside a server.");

  const guildId = interaction.guild.id;
  const q = getQueue(guildId);

  q.songs = [];
  q.playing = false;
  q.nowPlaying = null;

  q.player.stop();
  const conn = getVoiceConnection(guildId);
  if (conn) conn.destroy();

  q.ui.channelId = null;
  q.ui.messageId = null;

  return interaction.reply("🛑 Stopped and cleared queue!");
}

async function handleQueue(interaction) {
  if (!interaction.guild) return interaction.reply("❌ Use inside a server.");

  const q = getQueue(interaction.guild.id);

  let msg = "📌 **Queue**\n\n";
  msg += `🎶 Now Playing: **${q.nowPlaying?.title || "None"}**\n`;
  msg += `⏭ Up Next: **${q.songs[0]?.title || "None"}**\n`;
  msg += `🤖 AutoPlay: **${q.autoplay ? "ON" : "OFF"}**\n`;
  msg += `🎛 Mood: **${q.mood}**\n\n`;

  if (q.songs.length === 0) msg += "📭 Queue is empty.";
  else msg += q.songs.slice(0, 10).map((s, i) => `${i + 1}) ${s.title}`).join("\n");

  return interaction.reply(msg);
}

async function handleAutoplay(interaction, mode) {
  if (!interaction.guild) return interaction.reply("❌ Use inside a server.");
  const q = getQueue(interaction.guild.id);

  q.autoplay = mode === "on";

  await ensurePrefetch(interaction.guild.id).catch(() => {});
  await updateNowPlayingMessage(interaction.guild.id).catch(() => {});

  return interaction.reply(`🤖 AutoPlay is now **${q.autoplay ? "ON ✅" : "OFF ❌"}**`);
}

async function handleMood(interaction, mood) {
  if (!interaction.guild) return interaction.reply("❌ Use inside a server.");
  const q = getQueue(interaction.guild.id);

  const allowed = ["default", "chill", "party", "sad", "romantic", "focus"];
  if (!allowed.includes(mood)) {
    return interaction.reply(`❌ Mood must be: ${allowed.join(", ")}`);
  }

  q.mood = mood;

  await ensurePrefetch(interaction.guild.id).catch(() => {});
  await updateNowPlayingMessage(interaction.guild.id).catch(() => {});

  return interaction.reply(`🎛 Mood set to **${mood}** ✅`);
}

// ================= BUTTONS =================
async function handleButtonControl(interaction) {
  const guildId = interaction.guildId;
  const q = getQueue(guildId);

  if (!q) {
    try {
      return interaction.reply({ content: "❌ Nothing running.", ephemeral: true });
    } catch {
      return;
    }
  }

  try {
    await interaction.deferUpdate(); // prevents 10062
  } catch {}

  const id = interaction.customId;

  try {
    if (id === "music_pause") q.player.pause();
    if (id === "music_resume") q.player.unpause();
    if (id === "music_skip") q.player.stop();

    if (id === "music_stop") {
      q.songs = [];
      q.player.stop();

      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();

      q.playing = false;
      q.nowPlaying = null;

      q.ui.channelId = null;
      q.ui.messageId = null;

      try {
        await interaction.editReply({ content: "🛑 Stopped", embeds: [], components: [] });
      } catch {}
      return;
    }

    if (id === "music_shuffle") q.songs.sort(() => Math.random() - 0.5);
    if (id === "music_loop_song") q.loopSong = !q.loopSong;
    if (id === "music_loop_queue") q.loopQueue = !q.loopQueue;

    if (id === "music_autoplay") {
      q.autoplay = !q.autoplay;
      await ensurePrefetch(guildId).catch(() => {});
    }

    await updateNowPlayingMessage(guildId).catch(() => {});
  } catch (err) {
    console.log("❌ Button error:", err.message);
  }
}

module.exports = {
  handlePlay,
  handleSkip,
  handleStop,
  handleQueue,
  handleAutoplay,
  handleMood,
  getNowPlayingEmbedAndButtons,
  handleButtonControl,
};
