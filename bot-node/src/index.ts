import fs from "fs";
import path from "path";
import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  GuildMember,
  REST,
  Routes,
  SlashCommandBuilder,
  VoiceBasedChannel,
} from "discord.js";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

type SoundMapping = {
  keywords: string[];
  file: string;
  volume?: number;
};

type AppConfig = {
  mappings: SoundMapping[];
  cooldownMs: number;
  wsPort?: number;
  lang?: string;
};

type EnvConfig = {
  token: string;
  appId: string;
  guildId: string;
  wsPort: number;
};

type HitPayload = {
  type: string;
  keyword: string;
  text?: string;
  ts?: number;
  volume?: number;
};

type ResolvedMapping = SoundMapping & {
  filePath: string;
  volume: number;
};

const log = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`);
};

const rootConfigPath = path.resolve(__dirname, "..", "..", "config.json");
const sharedConfigPath = path.resolve(__dirname, "..", "..", "shared", "config.json"); // legacy
const legacyConfigPath = path.resolve(__dirname, "..", "config.json"); // legacy

const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const clampVolume = (raw?: number): number => {
  const vol = typeof raw === "number" ? raw : 1;
  return Math.min(Math.max(vol, 0), 2);
};

const resolveEnv = (defaultWsPort: number): EnvConfig => {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
  const read = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing environment variable: ${key}`);
    }
    return value;
  };

  const wsPortRaw = process.env.WS_PORT || String(defaultWsPort);
  const wsPort = Number(wsPortRaw);
  if (Number.isNaN(wsPort)) {
    throw new Error(`WS_PORT must be a number. Received "${wsPortRaw}"`);
  }

  return {
    token: read("DISCORD_TOKEN"),
    appId: read("DISCORD_APP_ID"),
    guildId: read("GUILD_ID"),
    wsPort,
  };
};

const resolveAppConfig = (): AppConfig => {
  const configPath =
    [rootConfigPath, sharedConfigPath, legacyConfigPath].find((p) => fs.existsSync(p)) || rootConfigPath;
  if (!fs.existsSync(configPath)) {
    throw new Error("config.json not found. Place it at repository root.");
  }
  const parsed = readJsonFile<AppConfig>(configPath);
  if (!Array.isArray(parsed.mappings) || parsed.mappings.length === 0) {
    throw new Error("config: mappings must be a non-empty array");
  }
  parsed.mappings.forEach((m, idx) => {
    if (!Array.isArray(m.keywords) || m.keywords.length === 0) {
      throw new Error(`config: mappings[${idx}].keywords must be a non-empty array`);
    }
    if (!m.file) {
      throw new Error(`config: mappings[${idx}].file is required`);
    }
    if (m.volume !== undefined && typeof m.volume !== "number") {
      throw new Error(`config: mappings[${idx}].volume must be a number when provided`);
    }
  });
  if (typeof parsed.cooldownMs !== "number" || parsed.cooldownMs < 0) {
    throw new Error("config: cooldownMs must be a positive number");
  }
  const normalizedMappings = parsed.mappings.map((m) => {
    const file = m.file || "";
    const withDir =
      path.isAbsolute(file) || file.startsWith("./") || file.startsWith("../") ? file : path.join("sounds", file);
    return { ...m, file: withDir, volume: clampVolume(m.volume) };
  });
  return {
    ...parsed,
    mappings: normalizedMappings,
  };
};

const appConfig = resolveAppConfig();
const env = resolveEnv(appConfig.wsPort ?? 3210);

const normalizeKeyword = (keyword: string) => keyword.toLowerCase();

const resolvedMappings: ResolvedMapping[] = appConfig.mappings.map((m) => ({
  ...m,
  volume: clampVolume(m.volume),
  filePath: path.isAbsolute(m.file) ? m.file : path.resolve(__dirname, "..", m.file),
}));

log("info", "Resolved mappings", {
  count: resolvedMappings.length,
  mappings: resolvedMappings.map((m) => ({
    keywords: m.keywords,
    file: m.filePath,
    exists: fs.existsSync(m.filePath)
  }))
});

resolvedMappings.forEach((m) => {
  if (!fs.existsSync(m.filePath)) {
    log("warn", `Sound file not found at ${m.filePath}. Place the mp3 before playing.`);
  }
});

const getMappingForKeyword = (keyword?: string): ResolvedMapping | null => {
  if (keyword) {
    const normalized = normalizeKeyword(keyword);
    const mapping = resolvedMappings.find((m) => m.keywords.some((kw) => normalizeKeyword(kw) === normalized));
    if (mapping) return mapping;
  }
  return resolvedMappings[0] ?? null;
};

const allKeywords = Array.from(new Set(resolvedMappings.flatMap((m) => m.keywords)));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const audioPlayer: AudioPlayer = createAudioPlayer();
const playbackQueue: { filePath: string; volume: number }[] = [];
let voiceConnection: VoiceConnection | null = null;
let lastHitAt = 0;

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join the voice channel you are in"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the current voice channel"),
  new SlashCommandBuilder().setName("testplay").setDescription("Play the configured sound once"),
].map((command) => command.toJSON());

const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.appId, env.guildId), { body: commands });
  log("info", "Slash commands registered");
};

const subscribePlayer = (connection: VoiceConnection) => {
  const subscription = connection.subscribe(audioPlayer);
  log("info", "Audio player subscribed to voice connection", {
    hasSubscription: !!subscription,
    connectionStatus: connection.state.status
  });
  return subscription;
};

const setupConnectionRecovery = (connection: VoiceConnection) => {
  connection.on("stateChange", async (oldState, newState) => {
    log("info", "Voice connection state changed", {
      from: oldState.status,
      to: newState.status
    });

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      log("warn", "Voice connection disconnected", {
        reason: newState.reason,
        closeCode: "closeCode" in newState ? newState.closeCode : undefined
      });

      if (
        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
        "closeCode" in newState &&
        newState.closeCode === 4014
      ) {
        try {
          await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        } catch {
          log("error", "Failed to reconnect, destroying connection");
          connection.destroy();
        }
      } else if (connection.rejoinAttempts < 5) {
        log("info", "Attempting to rejoin", { attempt: connection.rejoinAttempts + 1 });
        await new Promise((resolve) => setTimeout(resolve, (connection.rejoinAttempts + 1) * 1_000));
        connection.rejoin();
      } else {
        log("error", "Max rejoin attempts reached, destroying connection");
        connection.destroy();
      }
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      log("warn", "Voice connection destroyed");
      voiceConnection = null;
    } else if (newState.status === VoiceConnectionStatus.Ready) {
      log("info", "Voice connection ready");
    }
  });
};

const ensureVoiceConnection = async (channel: VoiceBasedChannel) => {
  if (!channel) {
    throw new Error("You must be in a voice channel");
  }

  log("info", "ensureVoiceConnection called", {
    channelId: channel.id,
    channelName: channel.name,
    hasExistingConnection: !!voiceConnection,
    existingStatus: voiceConnection?.state.status
  });

  if (
    voiceConnection &&
    voiceConnection.joinConfig.channelId === channel.id &&
    voiceConnection.state.status !== VoiceConnectionStatus.Destroyed
  ) {
    log("info", "Reusing existing voice connection");
    return voiceConnection;
  }

  if (voiceConnection) {
    log("info", "Destroying existing voice connection before creating new one");
    voiceConnection.destroy();
  }

  log("info", "Joining voice channel", {
    channelId: channel.id,
    guildId: channel.guild.id
  });

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: false,
  });

  setupConnectionRecovery(connection);
  subscribePlayer(connection);
  voiceConnection = connection;

  log("info", "Waiting for voice connection to become ready");
  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  log("info", "Voice connection established successfully");

  return connection;
};

const startPlaybackIfIdle = () => {
  log("info", "startPlaybackIfIdle called", {
    playerStatus: audioPlayer.state.status,
    queueLength: playbackQueue.length
  });

  if (audioPlayer.state.status !== AudioPlayerStatus.Idle) {
    log("info", "Player not idle, skipping", { status: audioPlayer.state.status });
    return;
  }

  const next = playbackQueue.shift();
  if (!next) {
    log("info", "Queue empty, nothing to play");
    return;
  }

  log("info", "Creating audio resource", { file: next.filePath, volume: next.volume });

  const resource: AudioResource = createAudioResource(next.filePath, { inlineVolume: true });
  if (resource.volume) {
    resource.volume.setVolume(next.volume);
  }
  audioPlayer.play(resource);
  log("info", "Started playback", { file: next.filePath, volume: next.volume, remaining: playbackQueue.length });
};

audioPlayer.on(AudioPlayerStatus.Idle, () => {
  log("info", "Audio player became idle");
  startPlaybackIfIdle();
});

audioPlayer.on(AudioPlayerStatus.Playing, () => {
  log("info", "Audio player started playing");
});

audioPlayer.on(AudioPlayerStatus.Paused, () => {
  log("info", "Audio player paused");
});

audioPlayer.on("error", (error) => {
  log("error", "Audio player error", { error: error.message, stack: error.stack });
  startPlaybackIfIdle();
});

const enqueuePlayback = (reason: string, filePath: string, volume: number) => {
  log("info", "enqueuePlayback called", { reason, filePath, volume });

  if (!fs.existsSync(filePath)) {
    log("warn", "Sound file missing, skipping playback", { file: filePath, reason });
    return;
  }

  const vol = clampVolume(volume);
  playbackQueue.push({ filePath, volume: vol });
  log("info", "Queued playback", {
    reason,
    queueLength: playbackQueue.length,
    file: filePath,
    volume: vol,
    playerStatus: audioPlayer.state.status
  });

  startPlaybackIfIdle();
};

const handleJoin = async (interaction: ChatInputCommandInteraction) => {
  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: "まずVCに参加してください。", ephemeral: true });
    return;
  }

  try {
    await ensureVoiceConnection(voiceChannel);
    await interaction.reply({ content: `Joined ${voiceChannel.name}`, ephemeral: true });
  } catch (error: any) {
    log("error", "Failed to join voice channel", { error: error.message });
    await interaction.reply({ content: "VC参加に失敗しました。", ephemeral: true });
  }
};

const handleLeave = async (interaction: ChatInputCommandInteraction) => {
  if (!voiceConnection) {
    await interaction.reply({ content: "まだVCにいません。", ephemeral: true });
    return;
  }
  voiceConnection.destroy();
  voiceConnection = null;
  await interaction.reply({ content: "VCから退出しました。", ephemeral: true });
};

const handleTestPlay = async (interaction: ChatInputCommandInteraction) => {
  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: "まずVCに参加してください。", ephemeral: true });
    return;
  }

  const mapping = getMappingForKeyword();
  if (!mapping) {
    await interaction.reply({
      content: "再生する音源が設定されていません。config.json を確認してください。",
      ephemeral: true,
    });
    return;
  }

  try {
    await ensureVoiceConnection(voiceChannel);
    enqueuePlayback("slash:testplay", mapping.filePath, mapping.volume);
    await interaction.reply({ content: "サウンドを再生します。", ephemeral: true });
  } catch (error: any) {
    log("error", "Test play failed", { error: error.message });
    await interaction.reply({ content: "再生に失敗しました。", ephemeral: true });
  }
};

const startWebSocketServer = () => {
  const wss = new WebSocketServer({ port: env.wsPort });
  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress;
    log("info", "WS client connected", { remote });

    ws.on("message", (data) => {
      try {
        log("info", "WS message received", { raw: data.toString() });
        const parsed = JSON.parse(data.toString()) as HitPayload;

        if (parsed.type !== "hit") {
          log("warn", "Unknown WS message type", { type: parsed.type });
          return;
        }
        if (!parsed.keyword) {
          log("warn", "WS hit missing keyword");
          return;
        }

        log("info", "Processing hit", { keyword: parsed.keyword, text: parsed.text, volume: parsed.volume });

        const now = Date.now();
        const cooldownRemaining = appConfig.cooldownMs - (now - lastHitAt);
        if (now - lastHitAt < appConfig.cooldownMs) {
          log("info", "Hit ignored due to cooldown", {
            keyword: parsed.keyword,
            cooldownRemaining: Math.ceil(cooldownRemaining),
            cooldownMs: appConfig.cooldownMs
          });
          return;
        }

        lastHitAt = now;

        log("info", "Voice connection check", {
          hasConnection: !!voiceConnection,
          status: voiceConnection?.state.status
        });

        if (!voiceConnection || voiceConnection.state.status === VoiceConnectionStatus.Destroyed) {
          log("warn", "Hit received but bot is not in a VC. Use /join first.", {
            hasConnection: !!voiceConnection,
            status: voiceConnection?.state.status
          });
          return;
        }

        const mapping = getMappingForKeyword(parsed.keyword);
        if (!mapping) {
          log("warn", "No sound mapped for keyword", { keyword: parsed.keyword });
          return;
        }

        log("info", "Mapping found", { keyword: parsed.keyword, file: mapping.filePath });

        const volume = clampVolume(parsed.volume ?? mapping.volume);
        enqueuePlayback(`ws:${parsed.keyword}`, mapping.filePath, volume);
        log("info", "Hit accepted and enqueued", { keyword: parsed.keyword, text: parsed.text, volume });
      } catch (error: any) {
        log("error", "Failed to parse WS message", { error: error.message, stack: error.stack });
      }
    });

    ws.on("close", () => log("info", "WS client disconnected", { remote }));
    ws.on("error", (error) => log("error", "WS client error", { error: (error as Error).message }));
  });

  wss.on("listening", () => log("info", `WS server listening on ws://127.0.0.1:${env.wsPort}`));
  wss.on("error", (error) => log("error", "WS server error", { error: (error as Error).message }));
};

const bootstrap = async () => {
  log("info", "Starting bootstrap", {
    cooldownMs: appConfig.cooldownMs,
    mappingsCount: appConfig.mappings.length,
    wsPort: env.wsPort
  });

  const shouldRegisterOnly = process.argv.includes("--register");
  await registerCommands();

  if (shouldRegisterOnly) {
    log("info", "Register-only mode, exiting");
    return;
  }

  log("info", "Starting WebSocket server");
  startWebSocketServer();

  // Discord.js v15 will emit this as clientReady; use it now to avoid deprecation warning.
  client.once("clientReady", (readyClient) => {
    log("info", `Logged in as ${readyClient.user.tag}`);
    log("info", `Awaiting keywords: ${allKeywords.join(", ")}`);
    log("info", `Audio player status: ${audioPlayer.state.status}`);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    log("info", "Command received", { command: interaction.commandName });

    if (interaction.commandName === "join") {
      await handleJoin(interaction);
    } else if (interaction.commandName === "leave") {
      await handleLeave(interaction);
    } else if (interaction.commandName === "testplay") {
      await handleTestPlay(interaction);
    }
  });

  log("info", "Logging in to Discord");
  await client.login(env.token);
};

bootstrap().catch((error) => {
  log("error", "Fatal error", { error: (error as Error).message });
  process.exit(1);
});

process.on("SIGINT", () => {
  log("info", "Shutting down...");
  voiceConnection?.destroy();
  process.exit(0);
});
