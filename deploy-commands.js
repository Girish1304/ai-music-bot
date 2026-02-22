require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song from YouTube")
    .addStringOption(opt =>
      opt.setName("query")
        .setDescription("Song name or YouTube link")
        .setRequired(true)
    ),

  new SlashCommandBuilder().setName("skip").setDescription("Skip current song"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear queue"),
  new SlashCommandBuilder().setName("queue").setDescription("Show queue"),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("⏳ Registering commands...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Commands registered!");
  } catch (err) {
    console.error(err);
  }
})();
