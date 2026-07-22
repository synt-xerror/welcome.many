/**
 * Configuração 100% via chat — não usa mais o ~/.manybot/manybot.conf.
 *
 * Um admin do grupo digita "!welcome config" DENTRO do grupo que vai
 * disparar a configuração (esse grupo vira o "canal de controle" da
 * conversa — é nele que se digita "pronto"/"padrão"/"cancelar" e se
 * escrevem as mensagens de texto livre). O bot então guia o admin por
 * um fluxo de perguntas; grupos são "escolhidos" mandando qualquer
 * mensagem DENTRO do grupo desejado.
 *
 * Cada grupo monitorado tem sua própria config, guardada em
 * ctx.settings.global sob a chave SETTINGS_KEY — dá pra rodar
 * "!welcome config" de novo pra reconfigurar (sobrescreve a entrada
 * existente pro mesmo grupo monitorado).
 *
 * i18n: todo texto que o bot ENVIA passa por ctx.i18n (locale/pt.json e
 * locale/en.json). O VOCABULÁRIO de comando — nomes de campo do "!welcome
 * set", palavras-chave como "pular"/"pronto"/"cancelar" e nomes de tema/
 * moldura — continua fixo em português: é sintaxe de comando (o que o
 * usuário precisa digitar), não texto de interface, então localizá-lo
 * mudaria o comportamento do bot, não só o idioma.
 */

/**
 * @typedef {import('@manybot/types').SetupContext} SetupContext
 * @typedef {import('@manybot/types').PluginContext} PluginContext
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Fontes (fallback em cascata, mesmo padrão do plugin quote) ──────────────
// Cada entrada só é registrada se o arquivo existir — se a pasta fonts/ estiver
// vazia ou incompleta, o plugin continua funcionando normalmente, só cai nas
// fontes genéricas do sistema (sans-serif/serif/monospace) em vez das
// bundladas. Namespaced "Welcome*" pra não colidir com fontes de outros
// plugins (ex. o "Quote*" do plugin quote) registradas no mesmo processo.
//
// Cada família tem Regular E Bold: o card sempre desenha o header, o nome e
// a inicial de fallback em negrito ("bold ...px"), não importa qual preset de
// fonte esteja ativo — sem o arquivo Bold registrado, esse texto sai fino ou
// com negrito sintético de qualidade inferior.
//
// WelcomeMath (STIXTwoMath) cobre símbolos matemáticos que nem DejaVu nem
// Liberation têm. Sem Unifont de propósito: cobertura de Unicode quase total,
// mas é bitmap — pixeliza em qualquer tamanho maior. Pra emoji/símbolos gerais
// sem esse efeito, a cascata usa NotoColorEmoji + STIXTwoMath + a cobertura
// já bem ampla do próprio DejaVu Sans (Latin estendido, Grego, Cirílico,
// setas, boa parte de Símbolos Diversos).
const FONT_DEFS = [
  { path: join(__dirname, "fonts", "DejaVuSans.ttf"), family: "WelcomeSans" },
  { path: join(__dirname, "fonts", "DejaVuSans-Bold.ttf"), family: "WelcomeSans" },
  { path: join(__dirname, "fonts", "LiberationSerif-Regular.ttf"), family: "WelcomeSerif" },
  { path: join(__dirname, "fonts", "LiberationSerif-Bold.ttf"), family: "WelcomeSerif" },
  { path: join(__dirname, "fonts", "DejaVuSansMono.ttf"), family: "WelcomeMono" },
  { path: join(__dirname, "fonts", "DejaVuSansMono-Bold.ttf"), family: "WelcomeMono" },
  { path: join(__dirname, "fonts", "NotoColorEmoji.ttf"), family: "WelcomeEmoji" },
  { path: join(__dirname, "fonts", "NotoSansBamum-Regular.ttf"), family: "WelcomeBamum" },
  { path: join(__dirname, "fonts", "NotoSerifKhitanSmallScript-Regular.ttf"), family: "WelcomeKhitan" },
  { path: join(__dirname, "fonts", "STIXTwoMath-Regular.ttf"), family: "WelcomeMath" },
];
for (const { path, family } of FONT_DEFS) {
  if (fs.existsSync(path)) {
    const ok = GlobalFonts.registerFromPath(path, family);
    if (!ok) console.warn(`[welcome] Falha ao registrar fonte: ${path}`);
  }
}

/** Presets de fonte pro card — cada um cai nas bundladas (se existirem) e depois na genérica do sistema. */
const FONT_STACKS = {
  padrao: `"WelcomeSans", "WelcomeEmoji", "WelcomeBamum", "WelcomeKhitan", "WelcomeMath", sans-serif`,
  serifa: `"WelcomeSerif", "WelcomeEmoji", "WelcomeBamum", "WelcomeKhitan", "WelcomeMath", sans-serif`,
  monoespacada: `"WelcomeMono", "WelcomeEmoji", "WelcomeMath", monospace`,
};
const DEFAULT_FONT = "padrao";

/** Foto de perfil usada quando a pessoa não tem uma (ou não deu pra baixar) e nenhum fallback customizado foi definido. */
const FALLBACK_AVATAR_PATH = join(__dirname, "fallback-profile.png");

const CARD_W = 900;
const CARD_H = 380;
const AVATAR_SIZE = 180;

const SETTINGS_KEY = "welcome:configs";
const COMMAND_NAME = "welcome";

const ADD_DELAY_MIN_MS = 8000;
const ADD_DELAY_MAX_MS = 25000;
const ADD_LONG_PAUSE_CHANCE = 0.15;
const ADD_LONG_PAUSE_MIN_MS = 30000;
const ADD_LONG_PAUSE_MAX_MS = 90000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fila global de adds + circuit breaker ───────────────────────────────────
// Todo `ctx.admin.add()` do plugin passa por aqui, não importa de qual grupo
// ou pessoa veio — isso serializa e espaça TODAS as tentativas do processo,
// evitando rajada quando várias pessoas entram em sequência. Depois de
// CIRCUIT_BREAKER_THRESHOLD falhas seguidas, o auto-add é desligado por
// CIRCUIT_BREAKER_COOLDOWN_MS e o admin é avisado — em vez de insistir e
// arriscar o número.
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000;
let addQueueTail = Promise.resolve();
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function enqueueAdd(task) {
  const result = addQueueTail.then(task);
  addQueueTail = result.catch(() => {});
  return result;
}

const MIN_NAME_LENGTH = 2;
const FALLBACK_NAME = "novo membro";

const WORDS_DEFAULT = ["padrão", "padrao", "default", "pular"];
const WORDS_DONE = ["pronto"];
const WORDS_CANCEL = ["cancelar", "cancel"];
const WORDS_NONE = ["nenhuma", "nenhum", "desativar", "remover"];
const WORDS_CONFIRM = ["confirmar", "confirmo", "sim"];

/** Nomes vazios, só espaço, ou com 1 caractere caem no fallback — mesmo tratamento de "sem nome". */
function resolveDisplayName(raw, fallback = FALLBACK_NAME) {
  const trimmed = (raw ?? "").trim();
  return trimmed.length >= MIN_NAME_LENGTH ? trimmed : fallback;
}

/** Substitui {nome} e {comunidade} (e outras chaves passadas) num template de mensagem. */
function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value ?? ""),
    template
  );
}

const SET_FIELDS = ["fundo", "moldura", "fonte", "avatar", "comunidade", "card", "simples", "pv", "pvfalha", "addgroup"];

const THEME_PRESETS = {
  roxo: ["#1f1147", "#3a1c71"],
  azul: ["#0f2027", "#2c5364"],
  verde: ["#134e5e", "#71b280"],
  vermelho: ["#8e0e00", "#3a0d0d"],
  dourado: ["#7a5c00", "#2b2100"],
  rosa: ["#780868", "#3a0a4f"],
  escuro: ["#0f0f0f", "#2c2c2c"],
  laranja: ["#7a2e00", "#2b1000"],
  ciano: ["#003b3b", "#001818"],
  cinza: ["#3a3a3a", "#141414"],
};
const DEFAULT_THEME = "roxo";
const FRAME_STYLES = ["circulo", "neon", "quadrado"];
const DEFAULT_FRAME = "circulo";
const HEX_RE = /^#([0-9a-f]{6})$/i;
const DEFAULT_IMAGE_OVERLAY = 0.7;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shade(hex, percent) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (percent < 0 ? c : 255 - c) * percent)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** Resolve a stored `cardBackground` selection into a [colorA, colorB] gradient pair. */
function resolveThemeColors(background) {
  if (background?.type === "solid") return [background.value, background.value];
  if (background?.type === "gradient") return background.value;
  if (background?.type === "color") return [background.value, shade(background.value, -0.45)];
  if (background?.type === "theme") return THEME_PRESETS[background.value] ?? THEME_PRESETS[DEFAULT_THEME];
  return THEME_PRESETS[DEFAULT_THEME];
}

/**
 * Interpreta texto livre de fundo (tema, #hex, "sólido #hex" ou "gradiente #hex #hex").
 * Não lida com imagem — isso é tratado à parte, onde dá pra baixar mídia.
 * @returns O background reconhecido, ou `null` se o texto não bateu com nenhum formato.
 */
function parseBackgroundText(text) {
  const trimmed = (text ?? "").trim();
  const word = normWord(trimmed);

  if (WORDS_DEFAULT.includes(word)) return { type: "theme", value: DEFAULT_THEME };
  if (THEME_PRESETS[word]) return { type: "theme", value: word };

  const soloMatch = trimmed.match(/^(?:s[oó]lido|solid)\s+(#[0-9a-f]{6})$/i);
  if (soloMatch) return { type: "solid", value: soloMatch[1] };

  const gradMatch = trimmed.match(/^(?:gradiente|gradient)\s+(#[0-9a-f]{6})\s+(#[0-9a-f]{6})$/i);
  if (gradMatch) return { type: "gradient", value: [gradMatch[1], gradMatch[2]] };

  if (HEX_RE.test(trimmed)) return { type: "color", value: trimmed };

  return null;
}

function normWord(s) {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Tenta adicionar contactId em destGroupId, passando pela fila global (com
 * delay) e pelo circuit breaker. Se falhar, gera o link de convite do grupo
 * de destino como alternativa (ou null se nem isso for possível) — quem
 * chama decide o que fazer com o link.
 *
 * @param {PluginContext} ctx
 * @param {string} contactId
 * @param {string} destGroupId
 * @param {string} [alertChatId] chat pra avisar se o circuit breaker abrir
 */
async function tryAddToGroup(ctx, contactId, destGroupId, alertChatId) {
  return enqueueAdd(async () => {
    if (Date.now() < circuitOpenUntil) {
      ctx.log.warn(`welcome: circuit breaker aberto, pulando add de ${contactId} em ${destGroupId}`);
      return getInviteLinkSafe(ctx, destGroupId);
    }

    const baseDelay = ADD_DELAY_MIN_MS + Math.random() * (ADD_DELAY_MAX_MS - ADD_DELAY_MIN_MS);
    const extraDelay = Math.random() < ADD_LONG_PAUSE_CHANCE
      ? ADD_LONG_PAUSE_MIN_MS + Math.random() * (ADD_LONG_PAUSE_MAX_MS - ADD_LONG_PAUSE_MIN_MS)
      : 0;
    await sleep(baseDelay + extraDelay);

    try {
      await ctx.admin.add(contactId).to(destGroupId);
      ctx.log.info(`welcome: userId="${contactId}" adicionado em "${destGroupId}"`);
      consecutiveFailures = 0;
      return null;
    } catch (err) {
      consecutiveFailures++;
      ctx.log.warn(`welcome: falha ao adicionar ${contactId} em ${destGroupId} — ${err.message}`);

      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        consecutiveFailures = 0;
        ctx.log.warn(`welcome: circuit breaker ABERTO por ${CIRCUIT_BREAKER_COOLDOWN_MS / 60000}min — muitas falhas seguidas ao adicionar`);
        if (alertChatId) {
          const { t } = ctx.i18n.createT(import.meta.url);
          ctx.send.to(alertChatId).text(
            t("circuitBreaker.alert", { minutes: CIRCUIT_BREAKER_COOLDOWN_MS / 60000 })
          ).catch(() => {});
        }
      }

      return getInviteLinkSafe(ctx, destGroupId);
    }
  });
}

/** @param {PluginContext} ctx */
async function getInviteLinkSafe(ctx, destGroupId) {
  try {
    return await ctx.admin.getInviteLink(destGroupId);
  } catch (err) {
    ctx.log.warn(`welcome: não foi possível gerar link de convite para "${destGroupId}" — ${err.message}`);
    return null;
  }
}

/**
 * Tenta carregar a imagem de avatar; se falhar (path nulo, arquivo corrompido,
 * etc.), retorna null e quem chama cai no fallback de iniciais.
 */
async function loadAvatarImage(avatarPath) {
  if (!avatarPath) return null;
  try {
    return await loadImage(avatarPath);
  } catch {
    return null;
  }
}

/**
 * Ordem de fallback pra foto do card: avatar real da pessoa → fallback
 * customizado do grupo (definido via "!welcome set avatar") → imagem padrão
 * bundlada com o plugin → (se nem essa existir) null, e o buildCard desenha
 * as iniciais do nome.
 */
function resolveAvatarSource(config, realAvatarPath, gotRealAvatar) {
  if (gotRealAvatar && realAvatarPath && fs.existsSync(realAvatarPath)) return realAvatarPath;
  if (config.avatarFallbackPath && fs.existsSync(config.avatarFallbackPath)) return config.avatarFallbackPath;
  if (fs.existsSync(FALLBACK_AVATAR_PATH)) return FALLBACK_AVATAR_PATH;
  return null;
}

async function buildCard({ name, subtitle, avatarPath, outPath, background, frame, headerLabel = "BEM-VINDO", fontFamily = FONT_STACKS[DEFAULT_FONT] }) {
  const canvas = createCanvas(CARD_W, CARD_H);
  const c = canvas.getContext("2d");
  const frameStyle = FRAME_STYLES.includes(frame) ? frame : DEFAULT_FRAME;

  // Fundo: imagem custom (cover-fit + overlay p/ legibilidade) ou gradiente de tema/cor.
  if (background?.type === "image" && fs.existsSync(background.value)) {
    const bg = await loadImage(background.value);
    const scale = Math.max(CARD_W / bg.width, CARD_H / bg.height);
    const w = bg.width * scale;
    const h = bg.height * scale;
    c.drawImage(bg, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
    const overlayStrength = typeof background.overlay === "number" ? background.overlay : DEFAULT_IMAGE_OVERLAY;
    const overlay = c.createLinearGradient(0, 0, 0, CARD_H);
    overlay.addColorStop(0, `rgba(10,8,20,${Math.min(1, overlayStrength * 0.8).toFixed(2)})`);
    overlay.addColorStop(1, `rgba(10,8,20,${Math.min(1, overlayStrength * 1.2).toFixed(2)})`);
    c.fillStyle = overlay;
    c.fillRect(0, 0, CARD_W, CARD_H);
  } else {
    const [colorA, colorB] = resolveThemeColors(background);
    const grad = c.createLinearGradient(0, 0, CARD_W, CARD_H);
    grad.addColorStop(0, colorA);
    grad.addColorStop(1, colorB);
    c.fillStyle = grad;
    c.fillRect(0, 0, CARD_W, CARD_H);
  }
  const accent = background?.type === "image" ? "#ffffff" : resolveThemeColors(background)[1];

  // Faixa decorativa diagonal sutil no topo.
  c.save();
  c.globalAlpha = 0.08;
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(CARD_W, 0);
  c.lineTo(CARD_W, 70);
  c.lineTo(0, 130);
  c.closePath();
  c.fill();
  c.restore();

  c.font = `bold 22px ${fontFamily}`;
  c.fillStyle = "rgba(255,255,255,0.35)";
  c.textAlign = "left";
  c.fillText(headerLabel, 36, 50);

  const ax = CARD_W / 2;
  const ay = CARD_H / 2 - 24;

  c.save();
  if (frameStyle === "neon") {
    c.shadowColor = accent;
    c.shadowBlur = 28;
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2 + 8, 0, Math.PI * 2);
    c.strokeStyle = accent;
    c.lineWidth = 6;
    c.stroke();
    c.shadowBlur = 0;
  } else if (frameStyle === "quadrado") {
    const half = AVATAR_SIZE / 2 + 8;
    const r = 28;
    c.beginPath();
    c.moveTo(ax - half + r, ay - half);
    c.arcTo(ax + half, ay - half, ax + half, ay + half, r);
    c.arcTo(ax + half, ay + half, ax - half, ay + half, r);
    c.arcTo(ax - half, ay + half, ax - half, ay - half, r);
    c.arcTo(ax - half, ay - half, ax + half, ay - half, r);
    c.closePath();
    c.fillStyle = "#ffffff";
    c.fill();
  } else {
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2 + 6, 0, Math.PI * 2);
    c.fillStyle = "#ffffff";
    c.fill();
  }
  c.restore();

  c.save();
  if (frameStyle === "quadrado") {
    const half = AVATAR_SIZE / 2;
    const r = 22;
    c.beginPath();
    c.moveTo(ax - half + r, ay - half);
    c.arcTo(ax + half, ay - half, ax + half, ay + half, r);
    c.arcTo(ax + half, ay + half, ax - half, ay + half, r);
    c.arcTo(ax - half, ay + half, ax - half, ay - half, r);
    c.arcTo(ax - half, ay - half, ax + half, ay - half, r);
    c.closePath();
  } else {
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2, 0, Math.PI * 2);
  }
  c.closePath();
  c.clip();

  const avatarImg = await loadAvatarImage(avatarPath);
  if (avatarImg) {
    c.drawImage(avatarImg, ax - AVATAR_SIZE / 2, ay - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
  } else {
    c.fillStyle = accent;
    c.fillRect(ax - AVATAR_SIZE / 2, ay - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
    c.fillStyle = "#ffffff";
    c.font = `bold 64px ${fontFamily}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(name.charAt(0).toUpperCase(), ax, ay + 4);
  }
  c.restore();

  c.textAlign = "center";
  c.fillStyle = "#ffffff";
  c.font = `bold 40px ${fontFamily}`;
  c.fillText(name, CARD_W / 2, ay + AVATAR_SIZE / 2 + 58, CARD_W - 80);

  const pillText = subtitle;
  c.font = `22px ${fontFamily}`;
  const pillW = c.measureText(pillText).width + 48;
  const pillX = CARD_W / 2 - pillW / 2;
  const pillY = ay + AVATAR_SIZE / 2 + 78;
  const pillH = 40;
  const pillR = pillH / 2;
  c.beginPath();
  c.moveTo(pillX + pillR, pillY);
  c.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, pillR);
  c.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, pillR);
  c.arcTo(pillX, pillY + pillH, pillX, pillY, pillR);
  c.arcTo(pillX, pillY, pillX + pillW, pillY, pillR);
  c.closePath();
  c.fillStyle = "rgba(255,255,255,0.14)";
  c.fill();
  c.fillStyle = "rgba(255,255,255,0.9)";
  c.textAlign = "center";
  c.fillText(pillText, CARD_W / 2, pillY + 27);

  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
  return outPath;
}

// ── Config storage (ctx.settings.global) ────────────────────────────────────

/** @param {PluginContext | SetupContext} ctx */
function loadConfigs(ctx) {
  return ctx.settings.global.get(SETTINGS_KEY, []);
}

/**
 * @param {PluginContext | SetupContext} ctx
 * @param {object[]} configs
 */
function saveConfigs(ctx, configs) {
  ctx.settings.global.set(SETTINGS_KEY, configs);
}

/** Usado no evento de entrada: casa só pelo grupo vigiado. */
function findConfig(configs, watchGroupId) {
  return configs.find((c) => c.watchGroupId === watchGroupId) ?? null;
}

/** Usado pelos comandos (status/set/reset): casa pelo grupo vigiado OU pelo grupo onde a config foi iniciada. */
function findConfigForChat(configs, chatId) {
  return configs.find((c) => c.watchGroupId === chatId || c.configChatId === chatId) ?? null;
}

// ── Wizard de configuração (!welcome config) ────────────────────────────────
// Uma sessão em memória por adminId — cada admin configura o seu próprio
// grupo de forma independente e concorrente. Só o admin que iniciou uma
// sessão consegue avançá-la (lookup é sempre por ctx.msg.sender). Sessão
// expira sozinha após SESSION_TIMEOUT_MS sem mensagem válida do admin.
// Fica em memória (não em ctx.storage) de propósito: é estado descartável de
// curta duração (no máx. SESSION_TIMEOUT_MS) — se o bot reiniciar no meio de
// um wizard, o pior caso é o admin ter que rodar "!welcome config" de novo.

const sessions = new Map(); // adminId -> session
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

const STEP_NUMBERS = {
  watchGroup: 1,
  cardTarget: 2,
  communityName: 3,
  cardBackground: 4,
  cardFrame: 5,
  cardMessage: 6,
  smallWelcome: 7,
  smallWelcomeMessage: 8,
  addGroups: 9,
  dmMessage: 10,
  dmFailMessage: 11,
};
const TOTAL_STEPS = 11;

/** @param {(key: string, vars?: object) => string} t */
function stepHeader(t, step) {
  return t("stepHeader", { step: STEP_NUMBERS[step], total: TOTAL_STEPS, label: t(`prompts.${step}.label`) });
}

/**
 * Variáveis dinâmicas que alguns prompts precisam (listas de tema/moldura,
 * mensagem padrão) — o resto do texto vem pronto do locale.
 * @param {(key: string, vars?: object) => string} t
 */
function promptVars(t, step) {
  switch (step) {
    case "cardBackground":
      return { themes: Object.keys(THEME_PRESETS).join(", ") };
    case "cardFrame":
      return { frames: FRAME_STYLES.filter((f) => f !== DEFAULT_FRAME).join(", ") };
    case "cardMessage":
      return { defaultMessage: t("defaults.cardMessage") };
    case "dmMessage":
      return { defaultMessage: t("defaults.dmMessage") };
    default:
      return {};
  }
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 * @param {string} step
 */
async function sendStep(ctx, session, step) {
  session.step = step;
  const { t } = ctx.i18n.createT(import.meta.url);
  const body = t(`prompts.${step}.body`, promptVars(t, step));
  await ctx.send.to(session.anchorChatId).text(`${stepHeader(t, step)}\n\n${body}`);
}

function startSession(adminId, anchorChatId) {
  const session = {
    adminId,
    anchorChatId,
    step: "watchGroup",
    watchGroupId: null,
    watchGroupName: null,
    cardTargetId: null,
    communityName: null,
    cardBackground: null,
    cardFrame: DEFAULT_FRAME,
    cardMessage: null,
    smallWelcomeGroupIds: [],
    smallWelcomeMessage: null,
    addGroupIds: [],
    dmMessage: null,
    dmFailMessage: null,
    timeoutHandle: null,
  };
  sessions.set(adminId, session);
  return session;
}

function endSession(adminId) {
  const session = sessions.get(adminId);
  if (session?.timeoutHandle) clearTimeout(session.timeoutHandle);
  sessions.delete(adminId);
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
function armTimeout(ctx, session) {
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  session.timeoutHandle = setTimeout(async () => {
    sessions.delete(session.adminId);
    const { t } = ctx.i18n.createT(import.meta.url);
    await ctx.send.to(session.anchorChatId).text(t("wizard.timeout"));
  }, SESSION_TIMEOUT_MS);
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
async function handleWizardMessage(ctx, session) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const word = normWord(ctx.msg.body);
  const inAnchor = ctx.chat.id === session.anchorChatId;

  if (WORDS_CANCEL.includes(word) && inAnchor) {
    endSession(session.adminId);
    await ctx.send.to(ctx.chat.id).text(t("wizard.cancelled"));
    return;
  }

  armTimeout(ctx, session);

  switch (session.step) {
    case "watchGroup": {
      if (!ctx.chat.isGroup) {
        await ctx.send.to(session.anchorChatId).text(t("wizard.needGroupWatch"));
        return;
      }
      session.watchGroupId = ctx.chat.id;
      session.watchGroupName = ctx.chat.name;

      const configs = loadConfigs(ctx);
      const existingCfg = configs.find((c) => c.watchGroupId === session.watchGroupId);
      if (existingCfg && existingCfg.configChatId !== session.anchorChatId) {
        existingCfg.configChatId = session.anchorChatId;
        saveConfigs(ctx, configs);
        endSession(session.adminId);
        await ctx.send.to(session.anchorChatId).text(
          t("wizard.reattached", { status: formatStatus(ctx, existingCfg) })
        );
        return;
      }

      await sendStep(ctx, session, "cardTarget");
      return;
    }

    case "cardTarget": {
      if (WORDS_DEFAULT.includes(word) && inAnchor) {
        session.cardTargetId = session.watchGroupId;
      } else if (ctx.chat.isGroup) {
        session.cardTargetId = ctx.chat.id;
      } else {
        await ctx.send.to(session.anchorChatId).text(t("wizard.needGroupCardTarget"));
        return;
      }
      await sendStep(ctx, session, "communityName");
      return;
    }

    case "communityName": {
      if (!inAnchor) return;
      const value = (ctx.msg.body ?? "").trim();
      session.communityName = WORDS_DEFAULT.includes(word) || value.length < MIN_NAME_LENGTH
        ? session.watchGroupName
        : value;
      await sendStep(ctx, session, "cardBackground");
      return;
    }

    case "cardBackground": {
      if (!inAnchor) return;

      if (ctx.msg.hasMedia && ctx.msg.type === "image") {
        const media = await ctx.msg.downloadMedia();
        if (media) {
          const bgPath = ctx.storage.resolve(`bg_${session.watchGroupId.replace(/[^a-z0-9]/gi, "")}.jpg`);
          fs.writeFileSync(bgPath, Buffer.from(media.data, "base64"));
          session.cardBackground = { type: "image", value: bgPath, overlay: DEFAULT_IMAGE_OVERLAY };
        }
      } else {
        const parsed = parseBackgroundText(ctx.msg.body);
        if (!parsed) {
          await ctx.send.to(session.anchorChatId).text(t("wizard.backgroundInvalid"));
          return;
        }
        session.cardBackground = parsed;
      }

      await sendStep(ctx, session, "cardFrame");
      return;
    }

    case "cardFrame": {
      if (!inAnchor) return;
      const chosen = WORDS_DEFAULT.includes(word) ? DEFAULT_FRAME : word;
      if (!FRAME_STYLES.includes(chosen)) {
        await ctx.send.to(session.anchorChatId).text(
          t("wizard.frameInvalid", { frames: FRAME_STYLES.join(", ") })
        );
        return;
      }
      session.cardFrame = chosen;
      await sendStep(ctx, session, "cardMessage");
      return;
    }

    case "cardMessage": {
      if (!inAnchor) return;
      session.cardMessage = WORDS_DEFAULT.includes(word) ? null : ctx.msg.body;
      await sendStep(ctx, session, "smallWelcome");
      return;
    }

    case "smallWelcome": {
      if (WORDS_DONE.includes(word) && inAnchor) {
        if (session.smallWelcomeGroupIds.length > 0) {
          await sendStep(ctx, session, "smallWelcomeMessage");
        } else {
          await sendStep(ctx, session, "addGroups");
        }
        return;
      }
      if (ctx.chat.isGroup && !session.smallWelcomeGroupIds.includes(ctx.chat.id)) {
        session.smallWelcomeGroupIds.push(ctx.chat.id);
        await ctx.send.to(session.anchorChatId).text(t("wizard.smallWelcomeAdded", { name: ctx.chat.name }));
      } else if (!ctx.chat.isGroup && inAnchor) {
        await ctx.send.to(session.anchorChatId).text(t("wizard.smallWelcomeNeedGroup"));
      }
      return;
    }

    case "smallWelcomeMessage": {
      if (!inAnchor) return;
      session.smallWelcomeMessage = WORDS_DEFAULT.includes(word) ? null : ctx.msg.body;
      await sendStep(ctx, session, "addGroups");
      return;
    }

    case "addGroups": {
      if (WORDS_DONE.includes(word) && inAnchor) {
        await sendStep(ctx, session, "dmMessage");
        return;
      }
      if (session.addGroupIds.length > 0) {
        await ctx.send.to(session.anchorChatId).text(t("wizard.addGroupOnlyOne"));
        return;
      }
      if (ctx.chat.isGroup) {
        session.addGroupIds.push(ctx.chat.id);
        await ctx.send.to(session.anchorChatId).text(t("wizard.addGroupAdded", { name: ctx.chat.name }));
      } else if (inAnchor) {
        await ctx.send.to(session.anchorChatId).text(t("wizard.addGroupNeedGroup"));
      }
      return;
    }

    case "dmMessage": {
      if (!inAnchor) return;
      session.dmMessage = WORDS_NONE.includes(word)
        ? null
        : WORDS_DEFAULT.includes(word)
          ? t("defaults.dmMessage")
          : ctx.msg.body;
      await sendStep(ctx, session, "dmFailMessage");
      return;
    }

    case "dmFailMessage": {
      if (!inAnchor) return;
      session.dmFailMessage = WORDS_DEFAULT.includes(word) ? "" : ctx.msg.body;

      const configs = loadConfigs(ctx);
      const finalConfig = {
        watchGroupId: session.watchGroupId,
        configChatId: session.anchorChatId,
        cardTargetId: session.cardTargetId,
        communityName: session.communityName,
        cardBackground: session.cardBackground,
        cardFrame: session.cardFrame,
        cardMessage: session.cardMessage,
        smallWelcomeGroupIds: session.smallWelcomeGroupIds,
        smallWelcomeMessage: session.smallWelcomeMessage,
        addGroupIds: session.addGroupIds,
        dmMessage: session.dmMessage,
        dmFailMessage: session.dmFailMessage,
      };
      const idx = configs.findIndex((c) => c.watchGroupId === finalConfig.watchGroupId);
      if (idx >= 0) configs[idx] = finalConfig; else configs.push(finalConfig);
      saveConfigs(ctx, configs);

      await ctx.send.to(session.anchorChatId).text(
        t("wizard.savedSuccess", { status: formatStatus(ctx, finalConfig) })
      );
      endSession(session.adminId);
      return;
    }
  }
}

// ── Status / set / reset helpers ─────────────────────────────────────────────

/**
 * @param {PluginContext} ctx
 * @param {string} id
 */
function chatLabel(ctx, id) {
  return ctx.wa.store.chats.get(id)?.name ?? id;
}

/**
 * Configs antigos (de antes desse campo existir) usam o nome do grupo monitorado como fallback.
 * @param {PluginContext} ctx
 * @param {object} config
 */
function getCommunityName(ctx, config) {
  const stored = (config.communityName ?? "").trim();
  return stored.length >= MIN_NAME_LENGTH ? stored : chatLabel(ctx, config.watchGroupId);
}

/** @param {(key: string, vars?: object) => string} t */
function describeBackground(t, background) {
  if (!background) return t("status.backgroundDefault", { theme: DEFAULT_THEME });
  if (background.type === "theme") return t("status.backgroundTheme", { theme: background.value });
  if (background.type === "color") return t("status.backgroundColor", { color: background.value });
  if (background.type === "solid") return t("status.backgroundSolid", { color: background.value });
  if (background.type === "gradient") return t("status.backgroundGradient", { a: background.value[0], b: background.value[1] });
  if (background.type === "image") {
    const pct = Math.round((background.overlay ?? DEFAULT_IMAGE_OVERLAY) * 100);
    return t("status.backgroundImage", { pct });
  }
  return t("status.backgroundDefault", { theme: DEFAULT_THEME });
}

/**
 * @param {PluginContext} ctx
 * @param {object} config
 */
function formatStatus(ctx, config) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const noGroups = t("status.none");

  return t("status.title", {
    watchGroup: chatLabel(ctx, config.watchGroupId),
    community: getCommunityName(ctx, config),
    cardTarget: chatLabel(ctx, config.cardTargetId),
    background: describeBackground(t, config.cardBackground),
    frame: config.cardFrame ?? DEFAULT_FRAME,
    font: config.cardFont ?? DEFAULT_FONT,
    avatarFallback: config.avatarFallbackPath ? t("status.custom") : t("status.default"),
    cardMessage: config.cardMessage ? t("status.custom") : t("status.default"),
    smallGroups: config.smallWelcomeGroupIds.length
      ? config.smallWelcomeGroupIds.map((id) => chatLabel(ctx, id)).join(", ")
      : noGroups,
    smallMessage: config.smallWelcomeMessage ? t("status.custom") : t("status.defaultSameAsCard"),
    addGroups: config.addGroupIds.length
      ? config.addGroupIds.map((id) => chatLabel(ctx, id)).join(", ")
      : noGroups,
    dmMessage: config.dmMessage ? t("status.enabled") : t("status.disabled"),
    dmFailMessage: config.dmFailMessage ? t("status.custom") : t("status.default"),
    fields: SET_FIELDS.join(", "),
  });
}

/** @param {PluginContext} ctx */
async function handleStatusCommand(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("status.needGroup"));
    return;
  }
  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("status.notConfigured"));
    return;
  }
  await ctx.msg.reply.text(formatStatus(ctx, config));
}

/** @param {PluginContext} ctx */
async function handleResetCommand(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("reset.needGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("reset.nothing"));
    return;
  }

  if (!WORDS_CONFIRM.includes(normWord(ctx.msg.args[1] ?? ""))) {
    await ctx.msg.reply.text(t("reset.confirmNeeded"));
    return;
  }

  saveConfigs(ctx, configs.filter((c) => c.watchGroupId !== config.watchGroupId));
  await ctx.msg.reply.text(t("reset.done"));
}

/** Passo do wizard que corresponde a cada campo de "!welcome set", pra reusar o mesmo texto de prompt. */
const FIELD_TO_STEP = {
  fundo: "cardBackground",
  moldura: "cardFrame",
  comunidade: "communityName",
  card: "cardMessage",
  simples: "smallWelcomeMessage",
  pv: "dmMessage",
  pvfalha: "dmFailMessage",
  addgrupo: "addGroups",
};

/** @param {(key: string, vars?: object) => string} t */
function quickEditPrompt(t, field) {
  const step = FIELD_TO_STEP[field];
  return t("quickEdit.title", { field, prompt: t(`prompts.${step}.body`, promptVars(t, step)) });
}

/**
 * @param {string} adminId
 * @param {string} anchorChatId
 * @param {string} field
 * @param {string} watchGroupId
 */
function startQuickEditSession(adminId, anchorChatId, field, watchGroupId) {
  const session = { adminId, anchorChatId, mode: "quickEdit", field, watchGroupId, timeoutHandle: null };
  sessions.set(adminId, session);
  return session;
}

/**
 * Aplica um valor de texto a um campo de config. Usada tanto por
 * "!welcome set <campo> <valor>" quanto pela resposta do modo guiado.
 * Em caso de valor inválido, chama `reply` com o motivo e retorna false —
 * quem chama não deve salvar nem avançar nesse caso.
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} field
 * @param {string} value
 * @param {(text: string) => Promise<unknown>} reply
 * @returns {Promise<boolean>}
 */
async function applySetField(ctx, config, field, value, reply) {
  const { t } = ctx.i18n.createT(import.meta.url);
  switch (field) {
    case "fundo": {
      if (ctx.msg.hasMedia && ctx.msg.type === "image") {
        const media = await ctx.msg.downloadMedia();
        if (!media) {
          await reply(t("applySet.imageDownloadFail"));
          return false;
        }
        const bgPath = ctx.storage.resolve(`bg_${config.watchGroupId.replace(/[^a-z0-9]/gi, "")}.jpg`);
        fs.writeFileSync(bgPath, Buffer.from(media.data, "base64"));
        config.cardBackground = { type: "image", value: bgPath, overlay: DEFAULT_IMAGE_OVERLAY };
        return true;
      }
      const escurecerMatch = value.match(/^(?:escurecer|escuro)\s+(\d{1,3})$/i);
      if (escurecerMatch) {
        if (config.cardBackground?.type !== "image") {
          await reply(t("applySet.darkenOnlyImage"));
          return false;
        }
        const pct = Math.min(100, Math.max(0, parseInt(escurecerMatch[1], 10)));
        config.cardBackground = { ...config.cardBackground, overlay: pct / 100 };
        return true;
      }
      const parsed = parseBackgroundText(value);
      if (!parsed) {
        await reply(t("applySet.backgroundInvalid", { themes: Object.keys(THEME_PRESETS).join(", ") }));
        return false;
      }
      config.cardBackground = parsed;
      return true;
    }
    case "moldura": {
      const chosen = WORDS_DEFAULT.includes(normWord(value)) ? DEFAULT_FRAME : normWord(value);
      if (!FRAME_STYLES.includes(chosen)) {
        await reply(t("applySet.frameInvalid", { frames: FRAME_STYLES.join(", ") }));
        return false;
      }
      config.cardFrame = chosen;
      return true;
    }
    case "fonte": {
      const chosen = WORDS_DEFAULT.includes(normWord(value)) ? DEFAULT_FONT : normWord(value);
      if (!FONT_STACKS[chosen]) {
        await reply(t("applySet.fontInvalid", { fonts: Object.keys(FONT_STACKS).join(", ") }));
        return false;
      }
      config.cardFont = chosen;
      return true;
    }
    case "avatar": {
      const word = normWord(value);
      if (WORDS_DEFAULT.includes(word) || WORDS_NONE.includes(word)) {
        config.avatarFallbackPath = null;
        return true;
      }
      if (!(ctx.msg.hasMedia && ctx.msg.type === "image")) {
        await reply(t("applySet.avatarNeedsImage"));
        return false;
      }
      const media = await ctx.msg.downloadMedia();
      if (!media) {
        await reply(t("applySet.imageDownloadFail"));
        return false;
      }
      const avatarFallbackPath = ctx.storage.resolve(`avatarfallback_${config.watchGroupId.replace(/[^a-z0-9]/gi, "")}.jpg`);
      fs.writeFileSync(avatarFallbackPath, Buffer.from(media.data, "base64"));
      config.avatarFallbackPath = avatarFallbackPath;
      return true;
    }
    case "comunidade": {
      const trimmed = value.trim();
      config.communityName = WORDS_DEFAULT.includes(normWord(value)) || trimmed.length < MIN_NAME_LENGTH ? null : trimmed;
      return true;
    }
    case "card": {
      config.cardMessage = WORDS_DEFAULT.includes(normWord(value)) ? null : value;
      return true;
    }
    case "pv": {
      const word = normWord(value);
      config.dmMessage = WORDS_NONE.includes(word) ? null : WORDS_DEFAULT.includes(word) ? t("defaults.dmMessage") : value;
      return true;
    }
    case "pvfalha": {
      const word = normWord(value);
      config.dmFailMessage = WORDS_NONE.includes(word) || WORDS_DEFAULT.includes(word) ? "" : value;
      return true;
    }
    case "simples": {
      const word = normWord(value);
      config.smallWelcomeMessage = WORDS_DEFAULT.includes(word) || WORDS_NONE.includes(word) ? null : value;
      return true;
    }
    case "addgroup": {
      const word = normWord(value);
      if (WORDS_NONE.includes(word) || WORDS_DEFAULT.includes(word) || WORDS_DONE.includes(word)) {
        config.addGroupIds = [];
        return true;
      }
      await reply(t("applySet.addgroupNeedsGroup"));
      return false;
    }
  }
  return false;
}

/**
 * @param {PluginContext} ctx
 * @param {string} field
 */
function extractSetValue(ctx, field) {
  const body = ctx.msg.body ?? "";
  const re = new RegExp(`^\\S+\\s+set\\s+${field}\\s*`, "i");
  return body.replace(re, "").trim();
}

/** @param {PluginContext} ctx */
async function handleSetCommand(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("set.needGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  const configs = loadConfigs(ctx);
  const idx = configs.findIndex((c) => c.watchGroupId === ctx.chat.id || c.configChatId === ctx.chat.id);
  if (idx < 0) {
    await ctx.msg.reply.text(t("set.notConfigured"));
    return;
  }

  const field = normWord(ctx.msg.args[1] ?? "");
  if (!SET_FIELDS.includes(field)) {
    await ctx.msg.reply.text(t("set.invalidField", { fields: SET_FIELDS.join(", ") }));
    return;
  }

  const value = extractSetValue(ctx, field);
  const hasImage = ctx.msg.hasMedia && ctx.msg.type === "image";
  const config = configs[idx];

  if (!value && !hasImage) {
    const senderId = ctx.msg.sender;
    if (sessions.has(senderId)) {
      await ctx.msg.reply.text(t("wizard.alreadyInProgress"));
      return;
    }
    const session = startQuickEditSession(senderId, ctx.chat.id, field, config.watchGroupId);
    armTimeout(ctx, session);
    await ctx.send.to(session.anchorChatId).text(quickEditPrompt(t, field));
    return;
  }

  const ok = await applySetField(ctx, config, field, value, (text) => ctx.msg.reply.text(text));
  if (!ok) return;

  saveConfigs(ctx, configs);
  await ctx.msg.reply.text(t("set.updated", { status: formatStatus(ctx, config) }));
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
async function handleQuickEditMessage(ctx, session) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const word = normWord(ctx.msg.body);
  const inAnchor = ctx.chat.id === session.anchorChatId;

  if (WORDS_CANCEL.includes(word) && inAnchor) {
    endSession(session.adminId);
    await ctx.send.to(ctx.chat.id).text(t("wizard.editCancelled"));
    return;
  }

  armTimeout(ctx, session);

  const configs = loadConfigs(ctx);
  const config = configs.find((c) => c.watchGroupId === session.watchGroupId);
  if (!config) {
    endSession(session.adminId);
    await ctx.send.to(session.anchorChatId).text(t("quickEdit.configGone"));
    return;
  }

  const reply = (text) => ctx.send.to(session.anchorChatId).text(text);

  if (session.field === "addgroup") {
    if (ctx.chat.isGroup && !inAnchor) {
      config.addGroupIds = [ctx.chat.id];
    } else if (inAnchor) {
      const ok = await applySetField(ctx, config, "addgroup", ctx.msg.body ?? "", reply);
      if (!ok) return;
    } else {
      return;
    }
  } else {
    if (!inAnchor) return;
    const ok = await applySetField(ctx, config, session.field, ctx.msg.body ?? "", reply);
    if (!ok) return;
  }

  saveConfigs(ctx, configs);
  endSession(session.adminId);
  await reply(t("set.updated", { status: formatStatus(ctx, config) }));
}

/** @param {SetupContext} ctx */
/**
 * Monta o card + textos de boas-vindas pra um "membro" (real, num evento de
 * entrada, ou simulado, no "!welcome test"). Não envia nada — só gera os
 * artefatos; quem chama decide os destinos. Sempre retorna `cleanup()` pra
 * apagar os arquivos temporários depois de enviar.
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} userId
 * @param {object|null} contact
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [idSuffix] sufixo pro nome dos arquivos temporários — evita colidir com um evento real rodando em paralelo
 */
async function renderMemberCard(ctx, config, userId, contact, t, idSuffix = "") {
  const name = resolveDisplayName(contact?.pushname ?? contact?.name, t("defaults.fallbackName"));
  const communityName = getCommunityName(ctx, config);
  const templateVars = { nome: name, comunidade: communityName };

  const defaultCardMessage = t("defaults.cardMessage");
  const caption = fillTemplate(config.cardMessage ?? defaultCardMessage, templateVars);
  const smallCaption = fillTemplate(config.smallWelcomeMessage ?? config.cardMessage ?? defaultCardMessage, templateVars);

  const safeId = userId.replace(/[^a-z0-9]/gi, "") + idSuffix;
  const realAvatarPath = ctx.storage.resolve(`tmp_avatar_${safeId}.jpg`);
  const gotRealAvatar = await ctx.contacts.getPfpPath(userId, realAvatarPath).catch((err) => {
    ctx.log.warn(`welcome: getPfpPath falhou — ${err.message}`);
    return null;
  });

  const cardPath = ctx.storage.resolve(`tmp_card_${safeId}.png`);
  let cardOk = false;
  try {
    await buildCard({
      name,
      subtitle: t("defaults.cardSubtitle", { community: communityName }),
      avatarPath: resolveAvatarSource(config, realAvatarPath, gotRealAvatar),
      outPath: cardPath,
      background: config.cardBackground ?? { type: "theme", value: DEFAULT_THEME },
      frame: config.cardFrame ?? DEFAULT_FRAME,
      fontFamily: FONT_STACKS[config.cardFont] ?? FONT_STACKS[DEFAULT_FONT],
      headerLabel: t("defaults.cardHeader"),
    });
    cardOk = true;
  } catch (err) {
    ctx.log.warn(`welcome: falha ao gerar card — ${err.message}`);
  }

  const cleanup = () => {
    fs.rmSync(cardPath, { force: true });
    if (gotRealAvatar) fs.rmSync(realAvatarPath, { force: true });
  };

  return { name, communityName, templateVars, caption, smallCaption, cardPath: cardOk ? cardPath : null, cleanup };
}

export async function setup(ctx) {
  ctx.events.on("group-participants.update", async (update) => {
    ctx.log.info(`welcome: evento recebido — ${JSON.stringify(update)}`);

    if (update.action !== "add") {
      ctx.log.info(`welcome: ignorado, action="${update.action}" (esperado "add")`);
      return;
    }

    const groupId = update.id;
    const configs = loadConfigs(ctx);
    const config = findConfig(configs, groupId);
    if (!config) {
      ctx.log.info(`welcome: grupo "${groupId}" não configurado, ignorando (rode "!welcome config" nesse grupo pra ativar)`);
      return;
    }

    const { t } = ctx.i18n.createT(import.meta.url);
    const target = config.cardTargetId ?? groupId;
    const participants = update.participants ?? [];
    if (participants.length === 0) {
      ctx.log.info("welcome: participants vazio, abortando");
      return;
    }

    for (const userId of participants) {
      ctx.log.info(`welcome: processando userId="${userId}"`);

      const contact = await ctx.contacts.get(userId, { groupId });
      const assets = await renderMemberCard(ctx, config, userId, contact, t);

      try {
        if (assets.cardPath) {
          await ctx.send.to(target).image(assets.cardPath, assets.caption);
          ctx.log.info("welcome: card enviado com sucesso");
        } else {
          await ctx.send.to(target).text(assets.caption);
        }
      } finally {
        assets.cleanup();
      }

      if (config.dmMessage) {
        try {
          await ctx.send.to(userId).text(fillTemplate(config.dmMessage, assets.templateVars));
        } catch (err) {
          ctx.log.warn(`welcome: falha ao mandar PV de boas-vindas para "${userId}" — ${err.message}`);
        }
      }

      if (config.addGroupIds.length) {
        const contactId = contact?.id ?? userId;
        const failedLinks = [];
        for (const destGroupId of config.addGroupIds) {
          if (destGroupId === groupId) continue;
          const link = await tryAddToGroup(ctx, contactId, destGroupId, config.configChatId);
          if (link) failedLinks.push(link);
        }
        if (failedLinks.length) {
          const intro = config.dmFailMessage
            ? fillTemplate(config.dmFailMessage, assets.templateVars)
            : t("defaults.failIntro");
          try {
            await ctx.send.to(userId).text(`${intro}\n\n${failedLinks.join("\n")}`);
          } catch (err) {
            ctx.log.warn(`welcome: falha ao mandar convites no PV de "${userId}" — ${err.message}`);
          }
        }
      }

      for (const smallTarget of config.smallWelcomeGroupIds) {
        if (smallTarget === target) continue;
        try {
          await ctx.send.to(smallTarget).text(assets.smallCaption);
        } catch (err) {
          ctx.log.warn(`welcome: falha ao mandar boas-vindas simples em "${smallTarget}" — ${err.message}`);
        }
      }
    }
  });
}

/**
 * Prévia SEM efeitos colaterais: tudo é enviado só no chat atual, nada vai
 * pros grupos configurados de verdade, ninguém é adicionado em lugar nenhum.
 * Usa os próprios dados de contato de quem rodou o comando como "novo membro".
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {object} assets retorno de renderMemberCard
 * @param {(key: string, vars?: object) => string} t
 */
async function runPreviewTest(ctx, config, assets, t) {
  const target = config.cardTargetId ?? config.watchGroupId;

  await ctx.msg.reply.text(t("test.previewHeader"));

  const cardLabel = t("test.previewCardLabel", { target: chatLabel(ctx, target) });
  if (assets.cardPath) {
    await ctx.send.to(ctx.chat.id).image(assets.cardPath, `${cardLabel}\n\n${assets.caption}`);
  } else {
    await ctx.send.to(ctx.chat.id).text(`${cardLabel}\n\n${assets.caption}`);
  }

  if (config.smallWelcomeGroupIds.length) {
    const names = config.smallWelcomeGroupIds.map((id) => chatLabel(ctx, id)).join(", ");
    await ctx.send.to(ctx.chat.id).text(`${t("test.previewSmallLabel", { target: names })}\n\n${assets.smallCaption}`);
  } else {
    await ctx.send.to(ctx.chat.id).text(t("test.previewNoSmall"));
  }

  if (config.dmMessage) {
    await ctx.send.to(ctx.chat.id).text(`${t("test.previewDmLabel")}\n\n${fillTemplate(config.dmMessage, assets.templateVars)}`);
  } else {
    await ctx.send.to(ctx.chat.id).text(t("test.previewNoDm"));
  }

  await ctx.send.to(ctx.chat.id).text(t("test.previewFooter"));
}

/**
 * Teste REAL: roda o mesmo pipeline do evento de entrada de verdade — envia
 * mensagem marcada como teste (pra quem estiver no grupo não acharque
 * alguém entrou de fato).
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} userId
 * @param {object|null} contact
 * @param {object} assets retorno de renderMemberCard
 * @param {(key: string, vars?: object) => string} t
 */
async function runRealTest(ctx, config, userId, contact, assets, t) {
  const target = config.cardTargetId ?? config.watchGroupId;
  const prefix = t("test.realCaptionPrefix");

  await ctx.msg.reply.text(t("test.realHeader"));

  try {
    if (assets.cardPath) {
      await ctx.send.to(target).image(assets.cardPath, prefix + assets.caption);
    } else {
      await ctx.send.to(target).text(prefix + assets.caption);
    }
  } catch (err) {
    ctx.log.warn(`welcome: teste real falhou ao enviar card — ${err.message}`);
  }

  if (config.dmMessage) {
    try {
      await ctx.send.to(userId).text(prefix + fillTemplate(config.dmMessage, assets.templateVars));
    } catch (err) {
      ctx.log.warn(`welcome: teste real falhou ao enviar PV — ${err.message}`);
    }
  }

  if (config.addGroupIds.length) {
    const contactId = contact?.id ?? userId;
    const failedLinks = [];
    for (const destGroupId of config.addGroupIds) {
      const link = await tryAddToGroup(ctx, contactId, destGroupId, config.configChatId);
      if (link) failedLinks.push(link);
    }
    if (failedLinks.length) {
      const intro = config.dmFailMessage ? fillTemplate(config.dmFailMessage, assets.templateVars) : t("defaults.failIntro");
      try {
        await ctx.send.to(userId).text(prefix + `${intro}\n\n${failedLinks.join("\n")}`);
      } catch (err) {
        ctx.log.warn(`welcome: teste real falhou ao enviar convites — ${err.message}`);
      }
    }
  }

  for (const smallTarget of config.smallWelcomeGroupIds) {
    if (smallTarget === target) continue;
    try {
      await ctx.send.to(smallTarget).text(prefix + assets.smallCaption);
    } catch (err) {
      ctx.log.warn(`welcome: teste real falhou ao enviar boas-vindas simples — ${err.message}`);
    }
  }

  await ctx.msg.reply.text(t("test.realDone"));
}

/**
 * "!welcome test" (prévia, só no chat atual) ou "!welcome test grupo"
 * (roda de verdade nos grupos configurados, marcado como teste).
 *
 * @param {PluginContext} ctx
 * @param {"preview" | "real"} mode
 */
async function handleTestCommand(ctx, mode) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("test.notConfigured"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  const userId = ctx.msg.sender;
  const contact = await ctx.contacts.get(userId).catch(() => null);
  const assets = await renderMemberCard(ctx, config, userId, contact, t, `_test${Date.now()}`);

  try {
    if (mode === "real") {
      await runRealTest(ctx, config, userId, contact, assets, t);
    } else {
      await runPreviewTest(ctx, config, assets, t);
    }
  } finally {
    assets.cleanup();
  }
}

/**
 * @param {PluginContext} ctx
 * @param {string} senderId
 * @param {object|undefined} existing
 */
async function handleConfigCommand(ctx, senderId, existing) {
  const { t } = ctx.i18n.createT(import.meta.url);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("wizard.startConfigNeedGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  if (existing) {
    await ctx.send.to(existing.anchorChatId).text(t("wizard.alreadyInProgress"));
    return;
  }

  const session = startSession(senderId, ctx.chat.id);
  armTimeout(ctx, session);
  await ctx.send.to(session.anchorChatId).text(t("prompts.watchGroup.body"));
}

/** @param {PluginContext} ctx */
export default async function (ctx) {
  if (ctx.msg.fromMe) return;

  const senderId = ctx.msg.sender;
  const existing = sessions.get(senderId);

  if (ctx.msg.is(COMMAND_NAME)) {
    const sub = (ctx.msg.args[0] ?? "").toLowerCase();
    switch (sub) {
      case "config":
        await handleConfigCommand(ctx, senderId, existing);
        return;
      case "status":
        await handleStatusCommand(ctx);
        return;
      case "reset":
        await handleResetCommand(ctx);
        return;
      case "set":
        await handleSetCommand(ctx);
        return;
      case "test": {
        const mode = (ctx.msg.args[1] ?? "").toLowerCase() === "grupo" ? "real" : "preview";
        await handleTestCommand(ctx, mode);
        return;
      }
      default: {
        const { t } = ctx.i18n.createT(import.meta.url);
        await ctx.msg.reply.text(t("help.text", { fields: SET_FIELDS.join(", ") }));
        return;
      }
    }
  }

  if (!existing) return;
  if (existing.mode === "quickEdit") {
    await handleQuickEditMessage(ctx, existing);
  } else {
    await handleWizardMessage(ctx, existing);
  }
}
