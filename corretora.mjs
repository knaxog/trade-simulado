#!/usr/bin/env node
// Corretora fictícia: preços reais da Binance (dados públicos, sem chave), dinheiro de mentira.
// Uso: node corretora.mjs <comando> [...]   (rode sem comando para ver a ajuda)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ESTADO = path.join(DIR, 'estado.json');
const HIST = path.join(DIR, 'historico.jsonl');
const PORTA = 8765;
const TRAVA = path.join(os.tmpdir(), 'trade-simulado.trava'); // fora do OneDrive, para não gerar sincronização
const DIARIO = path.join(DIR, 'diario.md');
const API = 'https://data-api.binance.vision/api/v3';

const SALDO_INICIAL = 1000;          // R$ fictícios
const TAXA = 0.0005;                 // 0,05% do nocional em cada ponta (taxa taker de futuros)
const LIQ = 0.9;                     // liquidação quando a perda chega a 90% da margem
// Formato híbrido (desde 25/11): alvo ~+50% da margem, stop até −30%, fecha sozinha após 12 h.
const REGRAS = { margemMin: 50, margemMax: 100, alavMax: 20, maxAbertas: 3, maxPorDia: 10, prazoH: 12, perdaMaxStop: 0.30 };
const PARES = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];

// ---------- utilidades ----------
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
const fp = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6));
const agora = () => new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const hojeLocal = (iso) => new Date(iso).toLocaleDateString('pt-BR');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normPar(s) {
  if (!s) throw new Error('Informe o par (ex.: BTC, ETH, SOL).');
  const p = s.toUpperCase().endsWith('USDT') ? s.toUpperCase() : s.toUpperCase() + 'USDT';
  if (!PARES.includes(p)) throw new Error(`Par ${p} fora da lista: ${PARES.join(', ')}`);
  return p;
}

function args(lista) {
  const pos = [], flags = {};
  for (let i = 0; i < lista.length; i++) {
    if (lista[i].startsWith('--')) flags[lista[i].slice(2)] = lista[++i];
    else pos.push(lista[i]);
  }
  return { pos, flags };
}

async function getJSON(url) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}: ${await r.text()}`);
      return await r.json();
    } catch (e) {
      if (tentativa >= 3) throw e;
      await sleep(1500 * tentativa);
    }
  }
}
const preco = async (par) => Number((await getJSON(`${API}/ticker/price?symbol=${par}`)).price);
const velas = (par, int, n) => getJSON(`${API}/klines?symbol=${par}&interval=${int}&limit=${n}`);

// ---------- estado (com trava, porque o monitor e as rodadas podem escrever ao mesmo tempo) ----------
async function comTrava(fn) {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(TRAVA); break; } catch {
      try { if (Date.now() - fs.statSync(TRAVA).mtimeMs > 60_000) fs.rmSync(TRAVA, { recursive: true }); } catch {}
      if (i > 100) throw new Error('Estado travado por outro processo.');
      await sleep(200);
    }
  }
  try { return await fn(); } finally { fs.rmSync(TRAVA, { recursive: true, force: true }); }
}
function carregar() {
  if (!fs.existsSync(ESTADO)) throw new Error('Conta não criada. Rode: node corretora.mjs iniciar');
  return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
}
function salvar(e) {
  fs.writeFileSync(ESTADO + '.tmp', JSON.stringify(e, null, 2));
  fs.renameSync(ESTADO + '.tmp', ESTADO);
}
const anotar = (txt) => fs.appendFileSync(DIARIO, txt + '\n');

// ---------- aviso no Windows ----------
function avisar(titulo, msg) {
  if (process.platform !== 'win32') return; // na nuvem não há área de notificação
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$null = $t.Item(0).AppendChild($x.CreateTextNode($env:AVISO_T))
$null = $t.Item(1).AppendChild($x.CreateTextNode($env:AVISO_M))
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  try {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, AVISO_T: titulo, AVISO_M: msg }, stdio: 'ignore', windowsHide: true,
    });
    c.on('error', () => {});
  } catch {}
}

// ---------- matemática da posição ----------
const dir = (p) => (p.lado === 'long' ? 1 : -1);
const nocional = (p) => p.margem * p.alav;
const pnlBruto = (p, px) => nocional(p) * dir(p) * (px / p.entrada - 1);
const precoLiq = (lado, entrada, alav) => entrada * (1 - (lado === 'long' ? 1 : -1) * LIQ / alav);

function fecharPosicao(e, p, px, motivo) {
  const taxaSaida = nocional(p) * (px / p.entrada) * TAXA;
  const bruto = pnlBruto(p, px);
  const devolvido = Math.max(0, p.margem + bruto - taxaSaida);
  const resultado = devolvido - p.margem - p.taxaEntrada; // líquido, já com as duas taxas
  e.saldo += devolvido;
  e.abertas = e.abertas.filter((x) => x.id !== p.id);
  const f = { ...p, saida: px, fechadoEm: new Date().toISOString(), motivoSaida: motivo, resultado, retornoMargem: resultado / p.margem };
  e.fechadas.push(f);
  anotar(`- **${agora()} · FECHOU #${p.id}** ${p.par} ${p.lado.toUpperCase()} em ${fp(px)} (${motivo}) → **${brl(resultado)} (${pct(f.retornoMargem)} da margem)**. Saldo livre: ${brl(e.saldo)}`);
  avisar(`${resultado >= 0 ? 'GANHOU' : 'PERDEU'} #${p.id} ${p.par} (${motivo})`,
    `${p.lado.toUpperCase()} ${p.alav}x saiu em ${fp(px)}: ${brl(resultado)} (${pct(f.retornoMargem)}). Simulação.`);
  return f;
}

// Repassa as velas de 1 minuto desde a última checagem: pega até pavio que o monitor não viu.
// Se stop e alvo caem na mesma vela, conta o stop (conservador).
// Posições com prazo fecham na abertura da primeira vela depois do prazo.
async function checarPosicao(e, p) {
  let inicio = p.ultimoCheck ?? Date.parse(p.abertoEm);
  const limite = p.prazoH ? Date.parse(p.abertoEm) + p.prazoH * 3600_000 : Infinity;
  for (;;) {
    const vs = await getJSON(`${API}/klines?symbol=${p.par}&interval=1m&startTime=${inicio}&limit=1000`);
    for (const v of vs) {
      if (v[0] >= limite) return fecharPosicao(e, p, +v[1], `prazo de ${p.prazoH}h`);
      const alta = +v[2], baixa = +v[3];
      const bateuStop = p.lado === 'long' ? baixa <= p.stop : alta >= p.stop;
      const bateuAlvo = p.lado === 'long' ? alta >= p.alvo : baixa <= p.alvo;
      if (bateuStop) return fecharPosicao(e, p, p.stop, 'stop');
      if (bateuAlvo) return fecharPosicao(e, p, p.alvo, 'alvo');
      p.ultimoCheck = v[0];
    }
    if (vs.length < 1000) return null;
    inicio = vs.at(-1)[0] + 60_000;
  }
}
const checarTodas = () => comTrava(async () => {
  const e = carregar();
  const fechadas = [];
  for (const p of [...e.abertas]) { const f = await checarPosicao(e, p); if (f) fechadas.push(f); }
  // Só grava quando algo fechou ou a cada 5 min (o OneDrive sincroniza cada gravação).
  if (fechadas.length || Date.now() - (e.salvoEm ?? 0) > 5 * 60_000) { e.salvoEm = Date.now(); salvar(e); }
  return fechadas;
});

// Foto da conta agora: posições com preço ao vivo e patrimônio total.
async function fotografia() {
  const e = carregar();
  const pares = [...new Set([...e.abertas.map((p) => p.par), 'BTCUSDT'])];
  const t = await getJSON(`${API}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pares))}`);
  const px = Object.fromEntries(t.map((x) => [x.symbol, +x.price]));
  const abertas = e.abertas.map((p) => ({ ...p, agora: px[p.par], pnl: pnlBruto(p, px[p.par]) }));
  const patrimonio = e.saldo + abertas.reduce((s, p) => s + p.margem + p.pnl, 0);
  return { e, abertas, patrimonio, btc: px.BTCUSDT };
}
async function guardarHistorico() {
  const f = await fotografia();
  fs.appendFileSync(HIST, JSON.stringify({ t: Date.now(), patrimonio: +f.patrimonio.toFixed(2), btc: f.btc }) + '\n');
}

// ---------- indicadores para a análise ----------
function ema(xs, n) { const k = 2 / (n + 1); let m = xs[0]; for (let i = 1; i < xs.length; i++) m = xs[i] * k + m * (1 - k); return m; }
function rsi(xs, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(vs, n = 14) {
  const tr = vs.slice(-n).map((v, i, a) => {
    const prev = i === 0 ? +vs[vs.length - n - 1][4] : +a[i - 1][4];
    return Math.max(+v[2] - +v[3], Math.abs(+v[2] - prev), Math.abs(+v[3] - prev));
  });
  return tr.reduce((s, x) => s + x, 0) / n;
}

// ---------- comandos ----------
const cmds = {
  async iniciar() {
    if (fs.existsSync(ESTADO)) throw new Error('A conta já existe (estado.json). Apague o arquivo para recomeçar do zero.');
    const btc = await preco('BTCUSDT');
    salvar({ saldoInicial: SALDO_INICIAL, saldo: SALDO_INICIAL, criadoEm: new Date().toISOString(), btcInicial: btc, proximoId: 1, abertas: [], fechadas: [] });
    if (!fs.existsSync(DIARIO)) anotar(`# Diário da corretora fictícia\n\nConta aberta em ${agora()} com ${brl(SALDO_INICIAL)} fictícios. BTC a ${fp(btc)} USDT (referência do "comprar e segurar").\n`);
    console.log(`Conta criada: ${brl(SALDO_INICIAL)} fictícios.`);
  },

  async precos() {
    const t = await getJSON(`${API}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(PARES))}`);
    for (const x of t) console.log(`${x.symbol.padEnd(9)} ${fp(+x.lastPrice).padStart(12)}  24h ${pct(+x.priceChangePercent / 100).padStart(7)}  máx ${fp(+x.highPrice)}  mín ${fp(+x.lowPrice)}`);
  },

  async analise(a) {
    const pares = a.pos.length ? a.pos.map(normPar) : PARES;
    for (const par of pares) {
      console.log(`\n== ${par} ==`);
      for (const int of ['15m', '1h', '4h']) {
        const vs = await velas(par, int, 200);
        const c = vs.map((v) => +v[4]); const px = c.at(-1);
        const ult20 = vs.slice(-20);
        const max = Math.max(...ult20.map((v) => +v[2])), min = Math.min(...ult20.map((v) => +v[3]));
        console.log(`${int.padEnd(3)} preço ${fp(px)} | EMA20 ${fp(ema(c, 20))} EMA50 ${fp(ema(c, 50))} | RSI14 ${rsi(c).toFixed(0)} | ATR14 ${fp(atr(vs))} (${(atr(vs) / px * 100).toFixed(2)}%) | 20 velas: máx ${fp(max)} mín ${fp(min)}`);
      }
    }
  },

  async abrir(a) {
    const [parTxt, lado, margemTxt, alavTxt] = a.pos;
    const par = normPar(parTxt);
    if (!['long', 'short'].includes(lado)) throw new Error('Lado tem que ser long ou short.');
    const margem = Number(margemTxt), alav = Number(alavTxt);
    const alvo = Number(a.flags.alvo), stop = Number(a.flags.stop), motivo = a.flags.motivo;
    if (!(margem >= REGRAS.margemMin && margem <= REGRAS.margemMax)) throw new Error(`Margem entre R$ ${REGRAS.margemMin} e R$ ${REGRAS.margemMax}.`);
    if (!(Number.isInteger(alav) && alav >= 1 && alav <= REGRAS.alavMax)) throw new Error(`Alavancagem inteira de 1 a ${REGRAS.alavMax}.`);
    if (!alvo || !stop || !motivo) throw new Error('Obrigatório: --alvo <preço> --stop <preço> --motivo "<por quê>".');

    return comTrava(async () => {
      const e = carregar();
      const hoje = hojeLocal(new Date().toISOString());
      const doDia = [...e.abertas, ...e.fechadas].filter((p) => hojeLocal(p.abertoEm) === hoje).length;
      if (e.abertas.length >= REGRAS.maxAbertas) throw new Error(`Já há ${REGRAS.maxAbertas} posições abertas.`);
      if (doDia >= REGRAS.maxPorDia) throw new Error(`Limite de ${REGRAS.maxPorDia} operações por dia atingido.`);
      const entrada = await preco(par);
      const liq = precoLiq(lado, entrada, alav);
      if (lado === 'long' && !(stop < entrada && entrada < alvo)) throw new Error(`Long: precisa stop < ${fp(entrada)} < alvo.`);
      if (lado === 'short' && !(alvo < entrada && entrada < stop)) throw new Error(`Short: precisa alvo < ${fp(entrada)} < stop.`);
      if (lado === 'long' ? stop <= liq : stop >= liq) throw new Error(`Stop além da liquidação (${fp(liq)}). Aproxime o stop ou baixe a alavancagem.`);
      const taxaEntrada = margem * alav * TAXA;
      if (e.saldo < margem + taxaEntrada) throw new Error(`Saldo livre insuficiente: ${brl(e.saldo)}.`);
      const perdaStop = -(margem * alav * (lado === 'long' ? 1 : -1) * (stop / entrada - 1)) / margem;
      if (perdaStop > REGRAS.perdaMaxStop) throw new Error(`Stop perderia ${pct(-perdaStop)} da margem; o máximo é ${pct(-REGRAS.perdaMaxStop)}. Aproxime o stop ou baixe a alavancagem.`);

      const p = { id: e.proximoId++, par, lado, margem, alav, entrada, alvo, stop, liq, taxaEntrada, motivo, abertoEm: new Date().toISOString(), prazoH: REGRAS.prazoH };
      e.saldo -= margem + taxaEntrada;
      e.abertas.push(p);
      salvar(e);
      const ganho = pnlBruto(p, alvo), perda = pnlBruto(p, stop);
      anotar(`- **${agora()} · ABRIU #${p.id}** ${par} ${lado.toUpperCase()} ${alav}x, margem ${brl(margem)}, entrada ${fp(entrada)}, alvo ${fp(alvo)} (${brl(ganho)}), stop ${fp(stop)} (${brl(perda)}). Motivo: ${motivo}`);
      avisar(`ABRIU #${p.id}: ${par} ${lado.toUpperCase()} ${alav}x`,
        `Entrada ${fp(entrada)} · alvo ${fp(alvo)} · stop ${fp(stop)} · margem ${brl(margem)}. Simulação, não é recomendação.`);
      console.log(`Aberta #${p.id} ${par} ${lado} ${alav}x em ${fp(entrada)}. Se bater o alvo: ${brl(ganho)} (${pct(ganho / margem)}); se bater o stop: ${brl(perda)} (${pct(perda / margem)}). Liquidação em ${fp(liq)}. Fecha sozinha em ${p.prazoH}h se nada bater.`);
    });
  },

  async fechar(a) {
    const id = Number(a.pos[0]);
    const fechadas = await checarTodas(); // se já bateu stop/alvo, vale o que bateu
    if (fechadas.some((f) => f.id === id)) return console.log(`#${id} já tinha fechado no ${fechadas.find((f) => f.id === id).motivoSaida}.`);
    return comTrava(async () => {
      const e = carregar();
      const p = e.abertas.find((x) => x.id === id);
      if (!p) throw new Error(`Não há posição aberta #${id}.`);
      const f = fecharPosicao(e, p, await preco(p.par), a.flags.motivo ? `manual: ${a.flags.motivo}` : 'manual');
      salvar(e);
      console.log(`Fechada #${id}: ${brl(f.resultado)} (${pct(f.retornoMargem)} da margem).`);
    });
  },

  async checar() {
    const f = await checarTodas();
    console.log(f.length ? f.map((x) => `#${x.id} fechou no ${x.motivoSaida}: ${brl(x.resultado)}`).join('\n') : 'Nada bateu stop ou alvo.');
  },

  async historico() {
    await guardarHistorico();
    console.log('Patrimônio registrado no historico.jsonl.');
  },

  async status() {
    await checarTodas();
    const e = carregar();
    let emJogo = 0;
    console.log(`Saldo livre: ${brl(e.saldo)}`);
    for (const p of e.abertas) {
      const px = await preco(p.par); const r = pnlBruto(p, px);
      emJogo += p.margem + r;
      console.log(`#${p.id} ${p.par} ${p.lado.toUpperCase()} ${p.alav}x | entrada ${fp(p.entrada)} agora ${fp(px)} | alvo ${fp(p.alvo)} stop ${fp(p.stop)} | ${brl(r)} (${pct(r / p.margem)})`);
    }
    if (!e.abertas.length) console.log('Nenhuma posição aberta.');
    const patrimonio = e.saldo + emJogo;
    console.log(`Patrimônio: ${brl(patrimonio)} (${pct(patrimonio / e.saldoInicial - 1)} desde o início)`);
  },

  async relatorio() {
    await checarTodas();
    const e = carregar();
    let emJogo = 0;
    for (const p of e.abertas) emJogo += p.margem + pnlBruto(p, await preco(p.par));
    const fs_ = e.fechadas, ganhos = fs_.filter((f) => f.resultado > 0);
    const total = fs_.reduce((s, f) => s + f.resultado, 0);
    const patrimonio = e.saldo + emJogo;
    const btc = await preco('BTCUSDT');
    console.log(`Desde ${new Date(e.criadoEm).toLocaleString('pt-BR')}`);
    console.log(`Operações fechadas: ${fs_.length} | acertos ${ganhos.length} (${fs_.length ? (ganhos.length / fs_.length * 100).toFixed(0) : 0}%) | abertas: ${e.abertas.length}`);
    console.log(`Resultado fechado: ${brl(total)} | Patrimônio: ${brl(patrimonio)} (${pct(patrimonio / e.saldoInicial - 1)})`);
    console.log(`Comparação "comprar BTC e segurar" no mesmo período: ${pct(btc / e.btcInicial - 1)}`);
    if (fs_.length) {
      const ord = [...fs_].sort((a, b) => b.resultado - a.resultado);
      console.log(`Melhor: #${ord[0].id} ${ord[0].par} ${brl(ord[0].resultado)} | Pior: #${ord.at(-1).id} ${ord.at(-1).par} ${brl(ord.at(-1).resultado)}`);
      const dobrou = fs_.filter((f) => f.retornoMargem >= 0.95).length;
      console.log(`Operações que quase dobraram ou dobraram a margem: ${dobrou}`);
    }
  },

  async monitor() {
    console.log(`Monitor ligado (${agora()}). Checa stop/alvo a cada 20 s e guarda o patrimônio a cada 5 min. Ctrl+C para parar.`);
    for (let volta = 0; ; volta++) {
      try {
        const f = await checarTodas();
        for (const x of f) console.log(`${agora()} #${x.id} ${x.par} fechou no ${x.motivoSaida}: ${brl(x.resultado)}`);
        if (volta % 15 === 0 || f.length) await guardarHistorico();
      } catch (err) { console.log(`${agora()} erro: ${err.message}`); }
      await sleep(20_000);
    }
  },

  async painel() {
    const servidor = http.createServer(async (req, res) => {
      try {
        if (req.url === '/' || req.url.startsWith('/?')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(fs.readFileSync(path.join(DIR, 'painel.html')));
        }
        if (req.url === '/api') {
          const f = await fotografia();
          const hist = fs.existsSync(HIST)
            ? fs.readFileSync(HIST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
          const diario = fs.existsSync(DIARIO) ? fs.readFileSync(DIARIO, 'utf8') : '';
          const hoje = hojeLocal(new Date().toISOString());
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({
            agora: Date.now(), salvoEm: f.e.salvoEm, saldoInicial: f.e.saldoInicial, saldo: f.e.saldo, criadoEm: f.e.criadoEm,
            btcInicial: f.e.btcInicial, btc: f.btc, patrimonio: f.patrimonio,
            abertas: f.abertas, fechadas: f.e.fechadas, historico: hist, diario, regras: REGRAS,
            hojeQtd: [...f.e.abertas, ...f.e.fechadas].filter((p) => hojeLocal(p.abertoEm) === hoje).length,
          }));
        }
        res.writeHead(404); res.end();
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ erro: err.message }));
      }
    });
    servidor.listen(PORTA, '127.0.0.1', () => console.log(`Painel em http://localhost:${PORTA} (Ctrl+C para parar)`));
    await new Promise(() => {});
  },
};

const AJUDA = `Corretora fictícia (preços reais da Binance, dinheiro de mentira)
  iniciar                                   cria a conta com ${brl(SALDO_INICIAL)}
  precos                                    preço e variação 24h dos pares
  analise [PAR...]                          EMA20/50, RSI, ATR em 15m/1h/4h
  abrir PAR long|short MARGEM ALAV --alvo P --stop P --motivo "..."
  fechar ID [--motivo "..."]                fecha a mercado
  checar                                    confere stop/alvo agora
  status                                    posições e patrimônio
  relatorio                                 balanço e comparação com BTC
  monitor                                   fica rodando e fecha no stop/alvo
  painel                                    abre o painel em http://localhost:${PORTA}
Regras: margem R$ ${REGRAS.margemMin}–${REGRAS.margemMax}, alavancagem até ${REGRAS.alavMax}x, stop de no máximo ${pct(-REGRAS.perdaMaxStop)} da margem,
até ${REGRAS.maxAbertas} abertas, ${REGRAS.maxPorDia} por dia, cada uma fecha sozinha após ${REGRAS.prazoH}h.
Pares: ${PARES.join(', ')}`;

const [cmd, ...resto] = process.argv.slice(2);
if (!cmds[cmd]) { console.log(AJUDA); process.exit(cmd ? 1 : 0); }
cmds[cmd](args(resto)).catch((err) => { console.error('Erro: ' + err.message); process.exitCode = 1; });
