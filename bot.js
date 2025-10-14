require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  REST, 
  Routes, 
  SlashCommandBuilder,
  PermissionsBitField
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

// === CONFIG ===
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const CLIENT_ID = process.env.CLIENT_ID;
// ===============

// === DATABASE SETUP ===
const db = new sqlite3.Database("./balances.db");
db.run("CREATE TABLE IF NOT EXISTS balances (user_id TEXT PRIMARY KEY, balance REAL)");

// === BOT INITIALIZATION ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed for guildMemberAdd
  ],
  partials: [Partials.Channel],
});

// === SLASH COMMANDS ===
const commands = [
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your current balance"),
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify who invited a new member (owner only)")
    .addUserOption(opt => opt.setName("member").setDescription("Member who was invited").setRequired(true))
    .addUserOption(opt => opt.setName("inviter").setDescription("User who invited the member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unverify")
    .setDescription("Undo a verification (owner only, removes 0.2 from inviter)")
    .addUserOption(opt => opt.setName("member").setDescription("Member to unverify").setRequired(true))
    .addUserOption(opt => opt.setName("inviter").setDescription("Inviter to remove balance from").setRequired(true)),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the top 15 users by balance"),
];

// === REGISTER SLASH COMMANDS ===
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands.map(cmd => cmd.toJSON()),
    });
    console.log("✅ Commands registered!");
  } catch (err) {
    console.error("❌ Error registering commands:", err);
  }
})();

// === HELPER FUNCTIONS ===
function getBalance(userId, callback) {
  db.get("SELECT balance FROM balances WHERE user_id = ?", [userId], (err, row) => {
    if (err) return callback(err);
    callback(null, row ? row.balance : 0);
  });
}

function addBalance(userId, amount) {
  db.run(
    "INSERT INTO balances (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?",
    [userId, amount, amount]
  );
}

function getLeaderboard(limit, callback) {
  db.all("SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT ?", [limit], (err, rows) => {
    if (err) return callback(err);
    callback(null, rows || []);
  });
}

// === BOT EVENTS ===
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// === MEMBER JOIN EVENT (auto verify channel) ===
client.on("guildMemberAdd", async (member) => {
  try {
    const guild = member.guild;
    const owner = await guild.members.fetch(OWNER_ID);

    // Create a channel name like "verify-username"
    const channelName = `verify-${member.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");

    // Create the private channel
    const verifyChannel = await guild.channels.create({
      name: channelName,
      type: 0, // GUILD_TEXT
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: owner.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
    });

    // Optional welcome message
    await verifyChannel.send(`👋 Welcome ${member}! Please verify yourself here.`);
    console.log(`Created channel ${verifyChannel.name} for ${member.user.tag}`);
  } catch (err) {
    console.error("Error creating verify channel:", err);
  }
});

// === SLASH COMMAND HANDLER ===
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand() && !interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "balance") {
    await interaction.deferReply({ ephemeral: true });
    getBalance(interaction.user.id, (err, balance) => {
      if (err) return interaction.editReply("Error retrieving your balance.");
      interaction.editReply(`💰 Your current balance is **${balance.toFixed(2)}**`);
    });
  }

  else if (commandName === "verify") {
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: "❌ Only the owner can use this command.", ephemeral: true });

    await interaction.deferReply();

    const member = interaction.options.getUser("member");
    const inviter = interaction.options.getUser("inviter");

    addBalance(inviter.id, 0.2);
    interaction.editReply(`✅ Verified **${member.username}** was invited by **${inviter.username}**.\nAdded **0.2** to ${inviter.username}'s balance.`);
  }

  else if (commandName === "unverify") {
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: "❌ Only the owner can use this command.", ephemeral: true });

    await interaction.deferReply();

    const member = interaction.options.getUser("member");
    const inviter = interaction.options.getUser("inviter");

    addBalance(inviter.id, -0.2); // subtract 0.2

    interaction.editReply(`↩️ Unverified **${member.username}** who was invited by **${inviter.username}**.\nRemoved **0.2** from ${inviter.username}'s balance.`);
  }

  else if (commandName === "leaderboard") {
    await interaction.deferReply();

    getLeaderboard(15, (err, rows) => {
      if (err) return interaction.editReply("Error retrieving leaderboard.");
      if (!rows.length) return interaction.editReply("🏆 No data yet!");

      const formatted = rows
        .map((row, i) => `${i + 1}. <@${row.user_id}> — **${row.balance.toFixed(2)}**`)
        .join("\n");

      interaction.editReply(`🏆 **Top 15 Leaderboard**\n\n${formatted}`);
    });
  }
});

client.login(TOKEN);
