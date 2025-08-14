import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const API_BASE = "https://wallet.fastset.xyz/api/";
const CONFIG_FILE = "config.json";
const isDebug = false;

const tokens = [
  { name: "SET", tokenId: "Internal-FastSet", decimals: 0, faucetAmount: "98686" },
  { name: "USDC", tokenId: "ReFosxqpCeJTBuJXJOSoAFE8F4+fXpftTJBYs8qAaeI=", decimals: 6, faucetAmount: "1000000000" },
  { name: "ETH", tokenId: "webWlA8UWwxnPc+awV0isStdDwYyynDf+eoh3ezEzWc=", decimals: 18, faucetAmount: "3140000000000000000" },
  { name: "SOL", tokenId: "2EJhDfYD4V39bKTVgJUhEd0LAs3VUAfEiGRucXc9eHU=", decimals: 9, faucetAmount: "100000000000" },
  { name: "BTC", tokenId: "/NHeobovw7GeS14wseW3RmvFRQIojkfWEGG+0HaIPtE=", decimals: 8, faucetAmount: "100000000" }
];

const tokenIds = tokens.slice(1).map(t => t.tokenId);

let walletInfo = {
  address: "N/A",
  balanceSET: "0",
  balanceUSDC: "0.0000",
  balanceETH: "0.0000",
  balanceSOL: "0.0000",
  balanceBTC: "0.0000"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let recipients = [];
let ownAddresses = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  sendRepetitions: 1,
  tokenSendRanges: {
    SET: { min: 1, max: 10 },
    USDC: { min: 0.02, max: 0.045 },
    ETH: { min: 0.0003, max: 0.00075 },
    SOL: { min: 0.0003, max: 0.00075 },
    BTC: { min: 0.000003, max: 0.0000075 }
  }
};

const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function from5to8(data) {
  let acc = 0n;
  let bits = 0;
  const ret = [];
  const maxv = (1 << 8) - 1;
  for (let value of data) {
    acc = (acc << 5n) | BigInt(value);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      ret.push(Number((acc >> BigInt(bits)) & BigInt(maxv)));
    }
  }
  if (bits >= 5 || Number(acc & ((1n << BigInt(bits)) - 1n)) !== 0) {
    throw new Error("Padding error");
  }
  return Buffer.from(ret);
}

function decodeBech32WithoutVerify(address) {
  const lower = address.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) {
    throw new Error("Invalid bech32");
  }
  const hrp = lower.slice(0, pos);
  const data_str = lower.slice(pos + 1);
  const data = [];
  for (let c of data_str) {
    const idx = charset.indexOf(c);
    if (idx === -1) throw new Error("Invalid char");
    data.push(idx);
  }
  const data_data = data.slice(0, -6);
  const publicBytes = from5to8(data_data);
  return { hrp, publicBytes };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.sendRepetitions = Number(config.sendRepetitions) || 1;
      dailyActivityConfig.tokenSendRanges.SET.min = Number(config.tokenSendRanges?.SET?.min) || 1;
      dailyActivityConfig.tokenSendRanges.SET.max = Number(config.tokenSendRanges?.SET?.max) || 10;
      dailyActivityConfig.tokenSendRanges.USDC.min = Number(config.tokenSendRanges?.USDC?.min) || 0.02;
      dailyActivityConfig.tokenSendRanges.USDC.max = Number(config.tokenSendRanges?.USDC?.max) || 0.045;
      dailyActivityConfig.tokenSendRanges.ETH.min = Number(config.tokenSendRanges?.ETH?.min) || 0.0003;
      dailyActivityConfig.tokenSendRanges.ETH.max = Number(config.tokenSendRanges?.ETH?.max) || 0.00075;
      dailyActivityConfig.tokenSendRanges.SOL.min = Number(config.tokenSendRanges?.SOL?.min) || 0.0003;
      dailyActivityConfig.tokenSendRanges.SOL.max = Number(config.tokenSendRanges?.SOL?.max) || 0.00075;
      dailyActivityConfig.tokenSendRanges.BTC.min = Number(config.tokenSendRanges?.BTC?.min) || 0.000003;
      dailyActivityConfig.tokenSendRanges.BTC.max = Number(config.tokenSendRanges?.BTC?.max) || 0.0000075;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeApiCall(method, payload) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(API_BASE + method, payload, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (response.status !== 200) {
      throw new Error(`API Error: ${data.error || 'Unknown error'}`);
    }
    return data;
  } catch (error) {
    addLog(`API call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});


function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("account.json", "utf8");
    accounts = JSON.parse(data);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("No accounts found in account.json");
    }
    accounts.forEach((account, index) => {
      if (!account.privateKey || !account.address) {
        throw new Error(`Account at index ${index} is missing privateKey or address`);
      }
      const privateBytes = Buffer.from(account.privateKey, 'hex');
      const { publicBytes } = decodeBech32WithoutVerify(account.address);
      account.sender = publicBytes.toString('base64');
      const keyBytes = Buffer.concat([privateBytes, publicBytes]);
      account.key = keyBytes.toString('base64');
    });
    ownAddresses = accounts.map(acc => acc.address);
    addLog(`Loaded ${accounts.length} accounts from account.json`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function loadRecipients() {
  try {
    if (fs.existsSync("wallet.txt")) {
      const data = fs.readFileSync("wallet.txt", "utf8");
      recipients = data.split("\n").map(addr => addr.trim()).filter(addr => addr);
      if (recipients.length === 0) throw new Error("No recipients found in wallet.txt");
      addLog(`Loaded ${recipients.length} recipients from wallet.txt`, "success");
    } else {
      throw new Error("wallet.txt not found");
    }
  } catch (error) {
    addLog(`Failed to load recipients: ${error.message}`, "error");
    recipients = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const sender = account.sender;
      const accountInfo = await makeApiCall("getAccountInfo", { sender });
      const balanceSET = BigInt(accountInfo.balance).toString();
      const tokenBalances = accountInfo.tokenBalances || {};
      const balanceUSDC = BigInt(tokenBalances[tokens[1].tokenId] || 0);
      const formattedUSDC = (Number(balanceUSDC) / 10 ** tokens[1].decimals).toFixed(4);
      const balanceETH = BigInt(tokenBalances[tokens[2].tokenId] || 0);
      const formattedETH = (Number(balanceETH) / 10 ** tokens[2].decimals).toFixed(4);
      const balanceSOL = BigInt(tokenBalances[tokens[3].tokenId] || 0);
      const formattedSOL = (Number(balanceSOL) / 10 ** tokens[3].decimals).toFixed(4);
      const balanceBTC = BigInt(tokenBalances[tokens[4].tokenId] || 0);
      const formattedBTC = (Number(balanceBTC) / 10 ** tokens[4].decimals).toFixed(4);
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(account.address))}    ${chalk.bold.cyanBright(balanceSET.padEnd(8))}   ${chalk.bold.cyanBright(formattedUSDC.padEnd(8))}   ${chalk.bold.cyanBright(formattedETH.padEnd(8))}   ${chalk.bold.cyanBright(formattedSOL.padEnd(8))}   ${chalk.bold.cyanBright(formattedBTC.padEnd(8))}`;
      if (i === selectedWalletIndex) {
        walletInfo.address = account.address;
        walletInfo.balanceSET = balanceSET;
        walletInfo.balanceUSDC = formattedUSDC;
        walletInfo.balanceETH = formattedETH;
        walletInfo.balanceSOL = formattedSOL;
        walletInfo.balanceBTC = formattedBTC;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0 0.0000 0.0000 0.0000 0.0000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Saldo & Wallet Updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Saldo & Wallet update failed: ${error.message}`, "error");
    return [];
  }
}

async function dripFaucet(account, token) {
  const sender = account.sender;
  const recipient = sender;
  const amount = token.faucetAmount;
  const method = token.tokenId === "Internal-FastSet" ? "dripBalance" : "dripToken";
  const payload = {
    sender,
    info: {
      recipient,
      amount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  if (method === "dripBalance") delete payload.info.tokenId;
  await makeApiCall(method, payload);
  addLog(`Successfully claimed faucet for ${token.name}: ${amount}`, "success");
}

async function performSend(account, token, amountHuman) {
  if (recipients.length === 0) {
    throw new Error("No recipients loaded");
  }
  let randomRecipient;
  do {
    randomRecipient = recipients[Math.floor(Math.random() * recipients.length)];
  } while (ownAddresses.includes(randomRecipient));
  const { publicBytes } = decodeBech32WithoutVerify(randomRecipient);
  const recipient = publicBytes.toString('base64');
  const sender = account.sender;
  const key = account.key;
  const amount = (BigInt(Math.floor(parseFloat(amountHuman) * 10 ** token.decimals))).toString();
  const method = token.tokenId === "Internal-FastSet" ? "transferBalance" : "transferToken";
  const accountInfo = await makeApiCall("getAccountInfo", { sender });
  const nextNonce = accountInfo.nextNonce;
  let currentBalance;
  if (token.tokenId === "Internal-FastSet") {
    currentBalance = BigInt(accountInfo.balance);
  } else {
    currentBalance = BigInt(accountInfo.tokenBalances[token.tokenId] || 0);
  }
  if (currentBalance < BigInt(amount)) {
    addLog(`Insufficient balance for ${token.name}, claiming faucet.`, "wait");
    await dripFaucet(account, token);
    await sleep(5000); 
    const updatedInfo = await makeApiCall("getAccountInfo", { sender });
    if (token.tokenId === "Internal-FastSet") {
      currentBalance = BigInt(updatedInfo.balance);
    } else {
      currentBalance = BigInt(updatedInfo.tokenBalances[token.tokenId] || 0);
    }
    if (currentBalance < BigInt(amount)) {
      throw new Error("Faucet claim failed or insufficient.");
    }
  }
  const payload = {
    sender,
    key,
    nextNonce,
    transferInfo: {
      recipient,
      amount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  if (method === "transferBalance") delete payload.transferInfo.tokenId;
  await makeApiCall(method, payload);
  addLog(`Successfully sent ${amountHuman} ${token.name} to ${getShortAddress(randomRecipient)}`, "success");
}

async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Send: ${dailyActivityConfig.sendRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const account = accounts[accountIndex];
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(account.address)}`, "wait");

      for (let sendCount = 0; sendCount < dailyActivityConfig.sendRepetitions && !shouldStop; sendCount++) {
        const token = tokens[Math.floor(Math.random() * tokens.length)];
        const range = dailyActivityConfig.tokenSendRanges[token.name];
        const maxDecimals = Math.min(4, token.decimals);
        const amountHuman = (Math.random() * (range.max - range.min) + range.min).toFixed(maxDecimals);
        addLog(`Account ${accountIndex + 1} - Send ${sendCount + 1}: ${amountHuman} ${token.name}`, "info");
        try {
          await performSend(account, token, amountHuman);
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Send ${sendCount + 1}: Failed: ${error.message}`, "error");
        }
        if (sendCount < dailyActivityConfig.sendRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next send...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          if (dailyActivityInterval) {
            clearTimeout(dailyActivityInterval);
            dailyActivityInterval = null;
            addLog("Cleared daily activity interval.", "info");
          }
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog("Daily activity stopped successfully.", "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "FAST SET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Send Repetitions",
    "Set SET Send Range",
    "Set USDC Send Range",
    "Set ETH Send Range",
    "Set SOL Send Range",
    "Set BTC Send Range",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Send: ${dailyActivityConfig.sendRepetitions}x | FASTSET AUTO SEND BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(12)}           ${chalk.bold.cyan("SET".padEnd(8))}   ${chalk.bold.cyan("USDC".padEnd(8))}     ${chalk.bold.cyan("ETH".padEnd(8))}   ${chalk.bold.cyan("SOL".padEnd(8))}   ${chalk.bold.cyan("BTC".padEnd(8))}`;
    const separator = chalk.gray("-".repeat(80));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Send Repetitions":
      configForm.configType = "sendRepetitions";
      configForm.setLabel(" Enter Send Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.sendRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set SET Send Range":
      configForm.configType = "setSendRange";
      configForm.setLabel(" Enter SET Send Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSendRanges.SET.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSendRanges.SET.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set USDC Send Range":
      configForm.configType = "usdcSendRange";
      configForm.setLabel(" Enter USDC Send Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSendRanges.USDC.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSendRanges.USDC.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set ETH Send Range":
      configForm.configType = "ethSendRange";
      configForm.setLabel(" Enter ETH Send Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSendRanges.ETH.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSendRanges.ETH.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set SOL Send Range":
      configForm.configType = "solSendRange";
      configForm.setLabel(" Enter SOL Send Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSendRanges.SOL.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSendRanges.SOL.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set BTC Send Range":
      configForm.configType = "btcSendRange";
      configForm.setLabel(" Enter BTC Send Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSendRanges.BTC.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSendRanges.BTC.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = parseFloat(inputValue);
    if (["setSendRange", "usdcSendRange", "ethSendRange", "solSendRange", "btcSendRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "sendRepetitions") {
    dailyActivityConfig.sendRepetitions = Math.floor(value);
    addLog(`Send Repetitions set to ${dailyActivityConfig.sendRepetitions}`, "success");
  } else if (configForm.configType === "setSendRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSendRanges.SET.min = value;
    dailyActivityConfig.tokenSendRanges.SET.max = maxValue;
    addLog(`SET Send Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "usdcSendRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSendRanges.USDC.min = value;
    dailyActivityConfig.tokenSendRanges.USDC.max = maxValue;
    addLog(`USDC Send Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "ethSendRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSendRanges.ETH.min = value;
    dailyActivityConfig.tokenSendRanges.ETH.max = maxValue;
    addLog(`ETH Send Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "solSendRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSendRanges.SOL.min = value;
    dailyActivityConfig.tokenSendRanges.SOL.max = maxValue;
    addLog(`SOL Send Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "btcSendRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSendRanges.BTC.min = value;
    dailyActivityConfig.tokenSendRanges.BTC.max = maxValue;
    addLog(`BTC Send Range set to ${value} - ${maxValue}`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (["setSendRange", "usdcSendRange", "ethSendRange", "solSendRange", "btcSendRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    loadRecipients();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();