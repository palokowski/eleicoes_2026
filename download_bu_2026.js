const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');

const BASE_URL = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220';
const APP_URL = 'https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/6257/uf/ac/dados-de-urna/boletim-de-urna';
const CANDIDATE_CSV = path.join(__dirname, 'votos_presidente.csv');
const DEFAULT_OUTPUT = path.join(__dirname, 'data', '2026', '1-turno');
const UF_LIST = 'AC AL AP AM BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO ZZ'.split(' ');

function optionsFromArgs(argv) {
  const options = { ufs: null, limit: 0, rps: 50, batchSize: 20, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ufs') options.ufs = argv[++index].split(',').map((uf) => uf.trim().toUpperCase());
    else if (argument === '--limit') options.limit = Number(argv[++index]);
    else if (argument === '--rps') options.rps = Number(argv[++index]);
    else if (argument === '--batch-size') options.batchSize = Number(argv[++index]);
    else if (argument === '--out') options.output = path.resolve(argv[++index]);
    else if (argument === '--help') options.help = true;
    else throw new Error(`Argumento desconhecido: ${argument}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('--limit deve ser zero ou um inteiro positivo.');
  if (!Number.isInteger(options.rps) || options.rps < 1 || options.rps > 90) throw new Error('--rps deve ficar entre 1 e 90.');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) throw new Error('--batch-size deve ficar entre 1 e 100.');
  return options;
}

function printHelp() {
  console.log('Uso: node download_bu_2026.js [--ufs AC,SP] [--limit 1] [--rps 50] [--out caminho]');
  console.log('Sem --limit e --ufs, percorre todos os BUs disponíveis do 1o turno, Brasil e exterior.');
}

async function fetchTse(url, nextRequest) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextRequest.time);
    nextRequest.time = scheduledAt + nextRequest.interval;
    if (scheduledAt > now) await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'apuracao-presidente-bu/1.0' },
        signal: AbortSignal.timeout(45000)
      });
      if (response.ok || response.status === 404) return response;
      if (response.status !== 429 && response.status < 500) return response;
    } catch (error) {
      if (attempt === 3) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error(`Falha repetida ao consultar ${url}`);
}

async function fetchJson(url, nextRequest) {
  const response = await fetchTse(url, nextRequest);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TSE respondeu HTTP ${response.status} para ${url}`);
  return response.json();
}

async function fetchBuffer(url, nextRequest) {
  const response = await fetchTse(url, nextRequest);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TSE respondeu HTTP ${response.status} para ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function getSections(config, uf) {
  const sections = [];
  for (const coverage of config.abr || []) {
    for (const municipality of coverage.mu || []) {
      for (const zone of municipality.zon || []) {
        for (const section of zone.sec || []) {
          if (section.nsp) continue;
          sections.push({
            uf,
            municipality: String(municipality.cd).padStart(5, '0'),
            municipalityName: municipality.nm || '',
            zone: String(zone.cd).padStart(4, '0'),
            section: String(section.ns).padStart(4, '0'),
            aggregatedSections: (section.nsa || []).length,
            hasBu: Boolean(section.da && section.ha)
          });
        }
      }
    }
  }
  return sections;
}

async function loadTseDecoder() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 90000 });
  const ready = await page.evaluate(() => {
    window.webpackChunkapp.push([[987654321], {}, (webpackRequire) => {
      window.__tseWebpackRequire = webpackRequire;
    }]);
    const webpackRequire = window.__tseWebpackRequire;
    const factory = webpackRequire?.m?.[369];
    if (!factory) return false;

    const source = factory.toString();
    const signature = source.match(/^\s*(?:function\s*\w*\s*)?\(([^)]*)\)\s*(?:=>|\{)/);
    if (!signature) return false;
    const exportParameter = signature[1].split(',')[1]?.trim();
    if (!exportParameter) return false;

    const patchedSource = source.replace(/}\s*$/, `; ${exportParameter}.decodeBU = X; }`);
    const patchedFactory = new Function(`return (${patchedSource})`)();
    const module = { exports: {} };
    patchedFactory(module, module.exports, webpackRequire);
    window.__tseDecodeBU = module.exports.decodeBU;
    return typeof window.__tseDecodeBU === 'function';
  });
  if (!ready) {
    await browser.close();
    throw new Error('Nao foi possivel carregar o leitor oficial de BU do TSE.');
  }
  return { browser, page };
}

async function decodeBatch(page, files) {
  return page.evaluate((items) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      return items.map(({ base64, ...metadata }) => {
        try {
          const binary = atob(base64);
          const decoded = window.__tseDecodeBU(binary);
          const content = decoded?.conteudo?.entidadeBoletimUrna;
          const elections = content?.resultadosVotacaoPorEleicao?.content || [];
          const presidentElection = elections.find((election) => String(election.idEleicao?.value) === '6257');
          if (!presidentElection) throw new Error('Eleicao presidencial 6257 ausente no BU.');

          const candidates = [];
          for (const contest of presidentElection.resultadosVotacao?.content || []) {
            for (const total of contest.totaisVotosCargo?.content || []) {
              if (String(total.codigoCargoConsulta?.value) !== '1') continue;
              for (const vote of total.votosVotaveis?.content || []) {
                if (String(vote.tipoVoto?.value) !== '1') continue;
                const number = vote.identificacaoVotavel?.codigo?.value;
                if (number == null) continue;
                candidates.push({ number: String(number), votes: Number(vote.quantidadeVotos?.value || 0) });
              }
            }
          }
          if (!candidates.length) throw new Error('BU sem votos nominais para Presidente.');
          return { ...metadata, candidates, turnout: Number(content.qtdEleitoresCompareceram?.value || 0) };
        } catch (error) {
          return { ...metadata, decodeError: error.message };
        }
      });
    } finally {
      console.log = originalLog;
    }
  }, files.map((file) => ({ ...file.metadata, base64: file.buffer.toString('base64') })));
}

function parseOfficialCandidates() {
  const csv = require('node:fs').readFileSync(CANDIDATE_CSV, 'utf8');
  const rows = parse(csv, { bom: true, columns: true, delimiter: ';', skip_empty_lines: true });
  const candidateMap = new Map();
  for (const row of rows) {
    if (row.nivel === 'br') candidateMap.set(String(row.numero), { candidate: row.candidato, party: row.partido });
  }
  return { rows, candidateMap };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filename, columns, rows) {
  const lines = [columns.join(';'), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(';'))];
  await fs.writeFile(filename, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function candidateDiffs(actual, official, locations) {
  const diffs = [];
  for (const location of locations) {
    const expected = new Map(official
      .filter((row) => row.nivel === location.nivel && (location.nivel === 'br' || row.uf === location.uf))
      .map((row) => [String(row.numero), Number(row.votos)]));
    const observed = actual.get(location.key) || new Map();
    const numbers = new Set([...expected.keys(), ...observed.keys()]);
    for (const number of numbers) {
      const expectedVotes = expected.get(number) || 0;
      const actualVotes = observed.get(number) || 0;
      if (actualVotes !== expectedVotes) diffs.push({ nivel: location.nivel, uf: location.uf, numero: number, oficial: expectedVotes, recontado: actualVotes, diferenca: actualVotes - expectedVotes });
    }
  }
  return diffs;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const selectedUfs = options.ufs || UF_LIST;
  const invalidUfs = selectedUfs.filter((uf) => !UF_LIST.includes(uf));
  if (invalidUfs.length) throw new Error(`UFs invalidas: ${invalidUfs.join(', ')}`);

  const nextRequest = { time: 0, interval: 1000 / options.rps };
  const sections = [];
  for (const uf of selectedUfs) {
    const lowerUf = uf.toLowerCase();
    const configUrl = `${BASE_URL}/config/${lowerUf}/${lowerUf}-p003220-cs.json`;
    const config = await fetchJson(configUrl, nextRequest);
    if (!config) throw new Error(`Configuracao BU nao encontrada para ${uf}.`);
    const ufSections = getSections(config, uf);
    sections.push(...ufSections);
    const available = ufSections.filter((section) => section.hasBu).length;
    console.log(`${uf}: ${available.toLocaleString('pt-BR')} BUs disponiveis; ${(ufSections.length - available).toLocaleString('pt-BR')} secoes ativas sem arquivo no indice`);
  }

  const sectionsWithoutBu = sections.filter((section) => !section.hasBu);
  const availableSections = sections.filter((section) => section.hasBu);
  const tasks = options.limit ? availableSections.slice(0, options.limit) : availableSections;
  console.log(`Total selecionado: ${tasks.length.toLocaleString('pt-BR')} secoes; limite ${options.rps} requisicoes/s.`);
  const { rows: officialRows, candidateMap } = parseOfficialCandidates();
  const voteTotals = new Map();
  const locationStats = new Map();
  const unrecognizedNominalVotes = new Map();
  const failures = [];
  const nonTotalizedSections = [];
  let processed = 0;
  let downloaded = 0;
  let turnout = 0;
  let representedSections = 0;

  const decoder = await loadTseDecoder();
  const rawRoot = path.join(options.output, 'boletins');
  await fs.mkdir(rawRoot, { recursive: true });

  try {
    for (let offset = 0; offset < tasks.length; offset += options.batchSize) {
      const batch = tasks.slice(offset, offset + options.batchSize);
      const availableFiles = [];
      const results = await Promise.all(batch.map(async (section) => {
        const directory = path.join(rawRoot, section.uf, section.municipality, `z${section.zone}`);
        const filename = path.join(directory, `s${section.section}.dat`);
        const statusFilename = `${filename}.status.json`;
        try {
          await fs.mkdir(directory, { recursive: true });
          let buffer;
          let sourceStatus = 'Totalizado';
          try {
            buffer = await fs.readFile(filename);
            try {
              sourceStatus = JSON.parse(await fs.readFile(statusFilename, 'utf8')).status || sourceStatus;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          } catch {
            const lowerUf = section.uf.toLowerCase();
            const auxName = `p003220-${lowerUf}-m${section.municipality}-z${section.zone}-s${section.section}-aux.json`;
            const sectionPath = `${BASE_URL}/dados/${lowerUf}/${section.municipality}/${section.zone}/${section.section}`;
            const aux = await fetchJson(`${sectionPath}/${auxName}`, nextRequest);
            const hashEntry = aux?.hashes?.find((entry) => entry.arq?.some((file) => file.tp === 'bu' || file.tp === 'busa'));
            const bulletin = hashEntry?.arq?.find((file) => file.tp === 'bu' || file.tp === 'busa');
            if (!hashEntry || !bulletin) return { section, missing: 'BU sem arquivo no auxiliar' };
            sourceStatus = hashEntry.st || 'Desconhecido';
            const url = `${sectionPath}/${hashEntry.hash}/${bulletin.nm}`;
            buffer = await fetchBuffer(url, nextRequest);
            if (!buffer) return { section, missing: 'arquivo BU nao encontrado' };
            await fs.writeFile(filename, buffer);
            await fs.writeFile(statusFilename, JSON.stringify({ status: sourceStatus, hash: hashEntry.hash, filename: bulletin.nm }), 'utf8');
            downloaded += 1;
          }
          if (sourceStatus !== 'Totalizado') nonTotalizedSections.push({ ...section, status: sourceStatus });
          availableFiles.push({ buffer, metadata: { ...section, filename, sourceStatus } });
          return null;
        } catch (error) {
          return { section, error: error.message };
        }
      }));

      const decoded = availableFiles.length ? await decodeBatch(decoder.page, availableFiles) : [];
      for (const item of decoded) {
        if (item.decodeError) {
          failures.push({ section: { uf: item.uf, municipality: item.municipality, zone: item.zone, section: item.section }, error: `Falha ao decodificar BU: ${item.decodeError}` });
          continue;
        }
        const stateKey = `uf:${item.uf}`;
        if (!voteTotals.has(stateKey)) voteTotals.set(stateKey, new Map());
        if (!locationStats.has(item.uf)) locationStats.set(item.uf, { sections: 0, turnout: 0, validVotes: 0 });
        const stateVotes = voteTotals.get(stateKey);
        const stats = locationStats.get(item.uf);
        stats.sections += 1;
        stats.turnout += item.turnout;
        turnout += item.turnout;
        representedSections += 1 + Number(item.aggregatedSections || 0);
        for (const candidate of item.candidates) {
          const candidateNumber = String(Number(candidate.number));
          const votes = Number(candidate.votes);
          if (!candidateMap.has(candidateNumber)) {
            const unrecognizedKey = `${item.uf}:${candidateNumber}`;
            unrecognizedNominalVotes.set(unrecognizedKey, (unrecognizedNominalVotes.get(unrecognizedKey) || 0) + votes);
            continue;
          }
          stateVotes.set(candidateNumber, (stateVotes.get(candidateNumber) || 0) + votes);
          stats.validVotes += votes;
          if (!voteTotals.has('br:BR')) voteTotals.set('br:BR', new Map());
          const nationalVotes = voteTotals.get('br:BR');
          nationalVotes.set(candidateNumber, (nationalVotes.get(candidateNumber) || 0) + votes);
        }
      }

      for (const result of results) if (result) failures.push(result);
      processed += decoded.filter((item) => !item.decodeError).length;
      if (offset + batch.length >= tasks.length || Math.floor((offset + batch.length) / 500) > Math.floor(offset / 500)) {
        console.log(`Progresso: ${Math.min(offset + batch.length, tasks.length).toLocaleString('pt-BR')}/${tasks.length.toLocaleString('pt-BR')} entradas; ${processed.toLocaleString('pt-BR')} BUs decodificados; ${downloaded.toLocaleString('pt-BR')} baixados nesta execucao; ${failures.length} falhas/indisponiveis.`);
      }
    }
  } finally {
    await decoder.browser.close();
  }

  const nationalVotes = voteTotals.get('br:BR') || new Map();
  const totalValidVotes = [...nationalVotes.values()].reduce((sum, value) => sum + value, 0);
  const csvRows = [];
  const locations = [{ nivel: 'br', uf: 'BR', key: 'br:BR' }, ...selectedUfs.map((uf) => ({ nivel: 'uf', uf, key: `uf:${uf}` }))];
  for (const location of locations) {
    const votes = voteTotals.get(location.key) || new Map();
    const validVotes = [...votes.values()].reduce((sum, value) => sum + value, 0);
    for (const [number, candidateVotes] of votes) {
      const candidate = candidateMap.get(number) || { candidate: `Candidato ${number}`, party: '' };
      csvRows.push({
        turno: 1,
        nivel: location.nivel,
        uf: location.nivel === 'br' ? '' : location.uf,
        cd_municipio: '',
        municipio: location.nivel === 'br' ? 'BRASIL' : location.uf === 'ZZ' ? 'EXTERIOR' : location.uf,
        numero: number,
        candidato: candidate.candidate,
        partido: candidate.party,
        votos: candidateVotes,
        pct_validos: validVotes ? (candidateVotes / validVotes * 100).toFixed(2).replace('.', ',') : '0,00',
        atualizado_em: new Date().toISOString()
      });
    }
  }
  csvRows.sort((left, right) => left.nivel.localeCompare(right.nivel) || left.uf.localeCompare(right.uf) || Number(right.votos) - Number(left.votos));

  const fullScope = !options.limit && UF_LIST.every((uf) => selectedUfs.includes(uf));
  const officialNationalValidVotes = Number(officialRows
    .filter((row) => row.nivel === 'br')
    .reduce((sum, row) => sum + Number(row.votos), 0));
  const officialScopedValidVotes = fullScope
    ? officialNationalValidVotes
    : Number(officialRows
      .filter((row) => row.nivel === 'uf' && selectedUfs.includes(row.uf))
      .reduce((sum, row) => sum + Number(row.votos), 0));
  const comparisonLocations = fullScope
    ? locations
    : selectedUfs.map((uf) => ({ nivel: 'uf', uf, key: `uf:${uf}` }));
  const diffs = candidateDiffs(voteTotals, officialRows, comparisonLocations);
  const expectedAvailable = tasks.length;
  const complete = fullScope && sectionsWithoutBu.length === 0 && nonTotalizedSections.length === 0 && processed === expectedAvailable && failures.length === 0 && diffs.length === 0 && totalValidVotes === officialNationalValidVotes;
  const outputVotes = path.join(options.output, 'votos_presidente_bu.csv');
  const outputReport = path.join(options.output, 'reconciliacao_presidente_bu.json');
  await fs.mkdir(options.output, { recursive: true });
  await writeCsv(outputVotes, ['turno', 'nivel', 'uf', 'cd_municipio', 'municipio', 'numero', 'candidato', 'partido', 'votos', 'pct_validos', 'atualizado_em'], csvRows);
  await fs.writeFile(outputReport, JSON.stringify({
    election: '6257',
    pleito: '3220',
    source: 'BUs .dat oficiais do TSE decodificados pelo leitor do aplicativo oficial',
    complete,
    sectionsInIndex: sections.length,
    expectedSections: sections.length,
    expectedBuFiles: expectedAvailable,
    activeSectionsWithoutBu: sectionsWithoutBu,
    nonTotalizedBuSections: nonTotalizedSections,
    decodedSections: processed,
    representedSections,
    downloadedThisRun: downloaded,
    unavailableOrFailed: failures.length,
    turnOutFromBUs: turnout,
    validVotesFromBUs: totalValidVotes,
    officialValidVotesInScope: officialScopedValidVotes,
    officialNationalValidVotes,
    unrecognizedNominalVotes: [...unrecognizedNominalVotes].map(([key, votes]) => ({ uf: key.split(':')[0], numero: key.split(':')[1], votos: votes })),
    candidateDifferences: diffs,
    failures,
    generatedAt: new Date().toISOString()
  }, null, 2), 'utf8');

  console.log(`CSV recontado: ${outputVotes}`);
  console.log(`Relatorio: ${outputReport}`);
  console.log(`Votos validos dos BUs: ${totalValidVotes.toLocaleString('pt-BR')}`);
  console.log(`Reconciliacao completa: ${complete ? 'SIM' : 'NAO'}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});