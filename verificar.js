// Confere a recontagem feita a partir dos BUs contra o resultado oficial publicado pelo TSE.
//
// Uso:
//   node verificar.js                     # compara com os CSVs oficiais ja baixados (pasta do projeto)
//   node verificar.js --atualizar-oficial # baixa de novo o resultado oficial do TSE antes de comparar
//
// Grava data/2026/1-turno/verificacao.json e sai com codigo 1 se alguma conferencia falhar.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse } = require('csv-parse/sync');

const ROOT = __dirname;
const RECOUNT_DIR = path.join(ROOT, 'data', '2026', '1-turno');
const FRESH_OFFICIAL_DIR = path.join(RECOUNT_DIR, 'oficial');
const VERIFICATION_FILE = path.join(RECOUNT_DIR, 'verificacao.json');
const UF_LIST = 'AC AL AP AM BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO ZZ'.split(' ');
const LOCATIONS = ['BR', ...UF_LIST];

function readCsv(filename) {
  return parse(fs.readFileSync(filename, 'utf8'), { bom: true, columns: true, delimiter: ';', skip_empty_lines: true });
}

function locationOf(row) {
  return row.nivel === 'br' ? 'BR' : row.uf;
}

function votesByLocation(rows) {
  const result = new Map(LOCATIONS.map((location) => [location, new Map()]));
  for (const row of rows) {
    if (row.nivel !== 'br' && row.nivel !== 'uf') continue;
    const votes = result.get(locationOf(row));
    if (!votes) continue;
    const number = String(Number(row.numero));
    votes.set(number, (votes.get(number) || 0) + Number(row.votos));
  }
  return result;
}

function sum(map) {
  return [...map.values()].reduce((total, value) => total + value, 0);
}

function fetchFreshOfficial() {
  console.log('Baixando o resultado oficial atual do TSE (Brasil + UFs)...');
  execFileSync('python', ['apuracao_presidente.py', '--sem-municipios', '--saida', FRESH_OFFICIAL_DIR], { cwd: ROOT, stdio: 'inherit' });
  return FRESH_OFFICIAL_DIR;
}

function verify({ officialDir = ROOT } = {}) {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  // 1. Resultado oficial: completo e coerente consigo mesmo.
  const officialVotes = readCsv(path.join(officialDir, 'votos_presidente.csv'));
  const officialSummary = new Map(readCsv(path.join(officialDir, 'apuracao_presidente.csv'))
    .filter((row) => row.nivel === 'br' || row.nivel === 'uf')
    .map((row) => [locationOf(row), row]));
  const official = votesByLocation(officialVotes);
  const candidateNames = new Map(officialVotes.filter((row) => row.nivel === 'br')
    .map((row) => [String(Number(row.numero)), `${row.candidato} (${row.partido})`]));

  const missingOfficial = LOCATIONS.filter((location) => !officialSummary.has(location) || !official.get(location).size);
  add(missingOfficial.length ? 'falha' : 'ok', 'Resultado oficial do TSE presente para Brasil, 27 UFs e exterior',
    missingOfficial.length ? `Faltando: ${missingOfficial.join(', ')}` : `${LOCATIONS.length} localidades`);

  const incompleteOfficial = LOCATIONS.filter((location) => officialSummary.has(location) && Number(officialSummary.get(location).pct_secoes) !== 100);
  add(incompleteOfficial.length ? 'falha' : 'ok', 'Apuração oficial com 100% das seções totalizadas',
    incompleteOfficial.length ? `Abaixo de 100%: ${incompleteOfficial.join(', ')}` : '100% em todas as localidades');

  const incoherentOfficial = LOCATIONS.filter((location) => officialSummary.has(location)
    && sum(official.get(location)) !== Number(officialSummary.get(location).validos));
  const ufValidSum = UF_LIST.reduce((total, uf) => total + sum(official.get(uf)), 0);
  add(incoherentOfficial.length || ufValidSum !== sum(official.get('BR')) ? 'falha' : 'ok',
    'Resultado oficial coerente (soma dos candidatos = válidos; soma das UFs = Brasil)',
    incoherentOfficial.length ? `Incoerente em: ${incoherentOfficial.join(', ')}` : `Soma das UFs: ${ufValidSum.toLocaleString('pt-BR')}`);

  // 2. Recontagem: todos os BUs baixados e decodificados.
  let report = null;
  let recount = null;
  let sectionsWithoutBu = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(RECOUNT_DIR, 'reconciliacao_presidente_bu.json'), 'utf8'));
    recount = votesByLocation(readCsv(path.join(RECOUNT_DIR, 'votos_presidente_bu.csv')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!report || !recount) {
    add('falha', 'Recontagem dos BUs disponível', 'Arquivos da recontagem ainda não existem. Rode download_bu_2026.js até o fim.');
  } else {
    const missingRecount = UF_LIST.filter((uf) => !recount.get(uf).size);
    add(missingRecount.length ? 'falha' : 'ok', 'Recontagem cobre as 27 UFs e o exterior',
      missingRecount.length ? `Sem recontagem: ${missingRecount.join(', ')}` : `${UF_LIST.length} localidades`);
    add(report.decodedSections === report.expectedBuFiles ? 'ok' : 'falha', 'Todos os BUs do índice do TSE foram decodificados',
      `${report.decodedSections.toLocaleString('pt-BR')} de ${report.expectedBuFiles.toLocaleString('pt-BR')} BUs`);
    add(report.failures.length ? 'falha' : 'ok', 'Nenhum BU com erro de download ou leitura',
      report.failures.length ? `${report.failures.length} falhas (veja reconciliacao_presidente_bu.json)` : '0 falhas');
    sectionsWithoutBu = report.activeSectionsWithoutBu; // avaliado depois da comparação voto a voto
    if (report.nonTotalizedBuSections.length) {
      const byUfStatus = new Map();
      for (const item of report.nonTotalizedBuSections) {
        const key = `${item.uf}: ${item.status}`;
        byUfStatus.set(key, (byUfStatus.get(key) || 0) + 1);
      }
      add('aviso', 'BUs com situação diferente de "Totalizado" no índice do TSE (foram lidos e contados normalmente)',
        `${report.nonTotalizedBuSections.length.toLocaleString('pt-BR')} BUs — ${[...byUfStatus].map(([key, count]) => `${key} ${count.toLocaleString('pt-BR')}`).join('; ')}`);
    }
    if (report.busWithoutNominalVotes?.length) {
      add('aviso', 'BUs lidos sem nenhum voto nominal para Presidente (só brancos/nulos ou sem eleitores)',
        report.busWithoutNominalVotes.map((item) => `${item.uf} ${item.municipalityName} seção ${item.section}: comparecimento ${item.turnout}`).join('; '));
    }
    if (report.unrecognizedNominalVotes.length) {
      add('aviso', 'Votos para números que não constam como candidatos válidos (o TSE os conta como nulos)',
        report.unrecognizedNominalVotes.map((item) => `${item.uf}: nº ${item.numero} com ${item.votos.toLocaleString('pt-BR')} votos`).join('; '));
    }
    const officialTurnout = Number(officialSummary.get('BR')?.comparecimento || 0);
    if (missingRecount.length === 0) {
      add(report.turnOutFromBUs === officialTurnout ? 'ok' : 'aviso', 'Comparecimento somado dos BUs = comparecimento oficial',
        `BUs: ${report.turnOutFromBUs.toLocaleString('pt-BR')} · TSE: ${officialTurnout.toLocaleString('pt-BR')}`);
    }
  }

  // 3. Comparação voto a voto: cada candidato em cada localidade.
  const allUfsRecounted = UF_LIST.every((uf) => recount?.get(uf).size);
  const locations = LOCATIONS.map((location) => {
    const expected = official.get(location);
    const observed = recount?.get(location) || new Map();
    const recounted = observed.size > 0 && (location !== 'BR' || allUfsRecounted);
    const differences = [];
    if (recounted) for (const number of new Set([...expected.keys(), ...observed.keys()])) {
      const officialCount = expected.get(number) || 0;
      const recountCount = observed.get(number) || 0;
      if (officialCount !== recountCount) {
        differences.push({ number, candidate: candidateNames.get(number) || `Número ${number}`, official: officialCount, recount: recountCount, difference: recountCount - officialCount });
      }
    }
    return {
      location,
      officialValid: sum(expected),
      recountValid: recounted ? sum(observed) : null,
      status: !recounted ? 'pendente' : differences.length ? 'diferente' : 'igual',
      differences
    };
  });
  // Seções ativas sem BU no índice do TSE só são aceitáveis se o lugar delas bate voto a voto com o TSE
  // (ou seja, o resultado oficial também não tem votos delas).
  if (sectionsWithoutBu?.length) {
    const byUf = new Map();
    for (const item of sectionsWithoutBu) byUf.set(item.uf, (byUf.get(item.uf) || 0) + 1);
    const harmless = [...byUf.keys()].every((uf) => locations.find((item) => item.location === uf)?.status === 'igual');
    add(harmless ? 'aviso' : 'falha', harmless
      ? 'Seções ativas sem BU no índice do TSE (sem efeito: os votos desses lugares batem exatamente com o TSE)'
      : 'Seções ativas sem BU no índice do TSE',
    `${sectionsWithoutBu.length} seções — ${[...byUf].map(([uf, count]) => `${uf}: ${count}`).join('; ')}`);
  } else if (report) {
    add('ok', 'Nenhuma seção ativa sem BU no índice do TSE', '0 seções sem BU');
  }

  const different = locations.filter((item) => item.status === 'diferente');
  const pending = locations.filter((item) => item.status === 'pendente');
  add(different.length || pending.length ? 'falha' : 'ok', 'Votos de cada candidato iguais aos do TSE em todas as localidades',
    different.length ? `Diferenças em: ${different.map((item) => item.location).join(', ')}`
      : pending.length ? `Ainda sem recontagem: ${pending.map((item) => item.location).join(', ')}`
        : `${locations.length} localidades × ${candidateNames.size} candidatos conferidos`);

  return {
    verified: checks.every((check) => check.level !== 'falha'),
    checkedAt: new Date().toISOString(),
    officialSource: officialDir === ROOT ? 'CSVs oficiais do projeto' : 'Resultado oficial baixado do TSE nesta verificação',
    officialUpdatedAt: officialSummary.get('BR')?.atualizado_em || null,
    recountGeneratedAt: report?.generatedAt || null,
    totals: report ? {
      buFiles: report.decodedSections,
      representedSections: report.representedSections,
      validVotesFromBUs: report.validVotesFromBUs,
      officialValidVotes: sum(official.get('BR'))
    } : null,
    checks,
    locations
  };
}

function printResult(result) {
  const icons = { ok: 'OK   ', aviso: 'AVISO', falha: 'FALHA' };
  console.log('');
  for (const check of result.checks) console.log(`[${icons[check.level]}] ${check.label}\n        ${check.detail}`);
  console.log('');
  console.log('Local   Oficial TSE        Recontagem BUs     Situação');
  for (const item of result.locations) {
    const recountText = item.recountValid == null ? '—' : item.recountValid.toLocaleString('pt-BR');
    console.log(`${item.location.padEnd(8)}${item.officialValid.toLocaleString('pt-BR').padStart(14)}     ${recountText.padStart(14)}     ${item.status}`);
    for (const diff of item.differences) {
      console.log(`          ${diff.candidate}: TSE ${diff.official.toLocaleString('pt-BR')} · BUs ${diff.recount.toLocaleString('pt-BR')} (${diff.difference > 0 ? '+' : ''}${diff.difference.toLocaleString('pt-BR')})`);
    }
  }
  console.log('');
  console.log(result.verified
    ? 'RESULTADO: a recontagem dos BUs é IGUAL ao resultado oficial do TSE.'
    : 'RESULTADO: verificação NÃO aprovada. Veja as falhas acima.');
}

if (require.main === module) {
  const officialDir = process.argv.includes('--atualizar-oficial') ? fetchFreshOfficial() : ROOT;
  const result = verify({ officialDir });
  fs.mkdirSync(RECOUNT_DIR, { recursive: true });
  fs.writeFileSync(VERIFICATION_FILE, JSON.stringify(result, null, 2), 'utf8');
  printResult(result);
  console.log(`Relatório: ${VERIFICATION_FILE}`);
  process.exitCode = result.verified ? 0 : 1;
}

module.exports = { verify, fetchFreshOfficial, VERIFICATION_FILE, RECOUNT_DIR, FRESH_OFFICIAL_DIR };
