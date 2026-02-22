require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  handlePlay,
  handleSkip,
  handleStop,
  handleQueue,
  handleAutoplay,
  handleMood,
  getNowPlayingEmbedAndButtons,
  handleButtonControl,
} = require("./music");

// ✅ Discord Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ✅ Needed for music.js embed auto-update
global.client = client;

// ✅ Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song from YouTube")
    .addStringOption((opt) =>
      opt.setName("query").setDescription("Song name or YouTube URL").setRequired(true)
    ),

  new SlashCommandBuilder().setName("skip").setDescription("Skip current song"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear queue"),
  new SlashCommandBuilder().setName("queue").setDescription("Show queue"),

  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Turn autoplay on/off")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("on/off")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        )
    ),

  // ✅ NEW MOOD COMMAND
  new SlashCommandBuilder()
    .setName("mood")
    .setDescription("Set autoplay mood")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("default/chill/party/sad/romantic/focus")
        .setRequired(true)
        .addChoices(
          { name: "default", value: "default" },
          { name: "chill", value: "chill" },
          { name: "party", value: "party" },
          { name: "sad", value: "sad" },
          { name: "romantic", value: "romantic" },
          { name: "focus", value: "focus" }
        )
    ),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show now playing embed + buttons"),
].map((c) => c.toJSON());

// ✅ Register Commands (Guild = instant update)
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  if (!process.env.BOT_TOKEN) {
    console.log("❌ BOT_TOKEN missing in .env");
    process.exit(1);
  }

  if (!process.env.CLIENT_ID) {
    console.log("❌ CLIENT_ID missing in .env");
    process.exit(1);
  }

  if (!process.env.GUILD_ID) {
    console.log("❌ GUILD_ID missing in .env");
    process.exit(1);
  }

  console.log("⏳ Registering commands (Guild)...");
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Commands registered instantly!");
}

// ✅ Ready
client.once("clientReady", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

// ✅ Interaction handler
client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "play") {
        const query = interaction.options.getString("query");
        return await handlePlay(interaction, query);
      }

      if (interaction.commandName === "skip") return await handleSkip(interaction);
      if (interaction.commandName === "stop") return await handleStop(interaction);
      if (interaction.commandName === "queue") return await handleQueue(interaction);

      if (interaction.commandName === "autoplay") {
        const mode = interaction.options.getString("mode");
        return await handleAutoplay(interaction, mode);
      }

      // ✅ mood command
      if (interaction.commandName === "mood") {
        const type = interaction.options.getString("type");
        return await handleMood(interaction, type);
      }

      if (interaction.commandName === "nowplaying") {
        const data = getNowPlayingEmbedAndButtons(interaction.guildId);
        if (!data) return interaction.reply("❌ Nothing is playing.");
        return interaction.reply(data);
      }
    }

    // Buttons
    if (interaction.isButton()) {
      return await handleButtonControl(interaction);
    }
  } catch (err) {
    console.log("❌ Error while running interaction:", err);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "❌ Error while running command.",
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: "❌ Error while running command.",
          ephemeral: true,
        });
      }
    } catch (e) {
      console.log("⚠️ Failed to send error reply:", e.message);
    }
  }
});

// ✅ Start bot
(async () => {
  await registerCommands();
  await client.login(process.env.BOT_TOKEN);
})();
