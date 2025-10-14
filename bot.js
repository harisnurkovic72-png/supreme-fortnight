require("dotenv").config();
const keep_alive = require('./keep_alive.js');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require("discord.js");
const { Pool } = require("pg");
const path = require("path");

// === CONFIG ===
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL; // set on Render
// ===============

// === DATABASE SETUP (Postgres) ===
// Configure pool. For Render and many managed DBs we need ssl: { rejectUnauthorized: false }
const connectionOptions = DATABASE_URL
  ? { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : null;

const pool = connectionOptions ? new Pool(connectionOptions) : null;

async function ensureDB() {
  if (!pool) {
    console.warn("No DATABASE_URL found — running without persistent DB.");
    return;
  }
  // Create table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS balances (
      user_id TEXT PRIMARY KEY,
      balance DOUBLE PRECISION DEFAULT 0
    );
  `);
  console.log("✅ Ensured balances table exists (Postgres).");
}

// === Initialize DB (async) ===
(async () => {
  try {
    if (pool) {
      await pool.connect(); // optional - will throw if bad config
      await ensureDB();
      console.log("✅ Connected to Postgres");
    }
  } catch (err) {
    console.error("Database connection error:", err);
    // Do not exit; bot can still run in degraded mode if you want
  }
})();

// === BOT INITIALIZATION ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
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
if (!TOKEN) console.warn("No DISCORD_TOKEN / TOKEN env var found.");
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

// === HELPER FUNCTIONS (Postgres-backed) ===
async function getBalance(userId) {
  if (!pool) return 0;
  const res = await pool.query("SELECT balance FROM balances WHERE user_id = $1", [userId]);
  return res.rows[0] ? parseFloat(res.rows[0].balance) : 0;
}

async function addBalance(userId, amount) {
  if (!pool) return;
  // Upsert pattern: insert or update
  await pool.query(
    `INSERT INTO balances (user_id, balance)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
     SET balance = balances.balance + EXCLUDED.balance;`,
    [userId, amount]
  );
}

async function getLeaderboard(limit = 15) {
  if (!pool) return [];
  const res = await pool.query(
    "SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1",
    [limit]
  );
  return res.rows || [];
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

    const channelName = `verify-${member.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");

    const verifyChannel = await guild.channels.create({
      name: channelName,
      type: 0,
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

    await verifyChannel.send(`👋 welcome ${member}! please verify yourself here by telling us:
1. any of your social media profiles
2. who invited you?
3. how hard you work?`);
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
    try {
      const balance = await getBalance(interaction.user.id);
      await interaction.editReply(`💰 Your current balance is **${balance.toFixed(2)}**`);
    } catch (err) {
      console.error("Balance error:", err);
      await interaction.editReply("Error retrieving your balance.");
    }
  }

  else if (commandName === "verify") {
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: "❌ Only the owner can use this command.", ephemeral: true });

    await interaction.deferReply();

    const member = interaction.options.getUser("member");
    const inviter = interaction.options.getUser("inviter");

    try {
      await addBalance(inviter.id, 0.2);
      await interaction.editReply(`✅ Verified **${member.username}** was invited by **${inviter.username}**.\nAdded **0.2** to ${inviter.username}'s balance.`);
    } catch (err) {
      console.error("Verify error:", err);
      await interaction.editReply("Error updating balance.");
    }
  }

  else if (commandName === "unverify") {
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: "❌ Only the owner can use this command.", ephemeral: true });

    await interaction.deferReply();

    const member = interaction.options.getUser("member");
    const inviter = interaction.options.getUser("inviter");

    try {
      await addBalance(inviter.id, -0.2);
      await interaction.editReply(`↩️ Unverified **${member.username}** who was invited by **${inviter.username}**.\nRemoved **0.2** from ${inviter.username}'s balance.`);
    } catch (err) {
      console.error("Unverify error:", err);
      await interaction.editReply("Error updating balance.");
    }
  }

  else if (commandName === "leaderboard") {
    await interaction.deferReply();

    try {
      const rows = await getLeaderboard(15);
      if (!rows.length) return interaction.editReply("🏆 No data yet!");

      const formatted = rows
        .map((row, i) => `${i + 1}. <@${row.user_id}> — **${parseFloat(row.balance).toFixed(2)}**`)
        .join("\n");

      await interaction.editReply(`🏆 **Top 15 Leaderboard**\n\n${formatted}`);
    } catch (err) {
      console.error("Leaderboard error:", err);
      await interaction.editReply("Error retrieving leaderboard.");
    }
  }
});

client.login(TOKEN);
