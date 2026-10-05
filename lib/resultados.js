const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const RECOUNT_DIR = path.join(ROOT, 'data', '2026', '1-turno');
const stateNames = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais',
  MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco',
  PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia',
  RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo',
  TO: 'Tocantins', ZZ: 'Exterior', BR: 'Brasil'
};

function readCsv(filename) {
  return parse(fs.readFileSync(filename, 'utf8'), { bom: true, columns: true, delimiter: ';', skip_empty_lines: true });
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// A recontagem so e usada se a verificacao passou e foi feita sobre os arquivos atuais.
function readVerifiedRecount() {
  const report = readJson(path.join(RECOUNT_DIR, 'reconciliacao_presidente_bu.json'));
  const verification = readJson(path.join(RECOUNT_DIR, 'verificacao.json'));
  const current = Boolean(report && verification && verification.recountGeneratedAt === report.generatedAt);
  return {
    report,
    verification: current ? verification : null,
    rows: current && verification.verified ? readCsv(path.join(RECOUNT_DIR, 'votos_presidente_bu.csv')) : null
  };
}

function numberFrom(row, field) {
  return Number(row?.[field] || 0);
}

function summarizeLocation(rows, metadata) {
  const totalVotes = rows.reduce((sum, row) => sum + numberFrom(row, 'votos'), 0);
  const candidates = rows
    .map((row) => ({
      number: row.numero,
      candidate: row.candidato,
      party: row.partido,
      votes: numberFrom(row, 'votos'),
      percentage: totalVotes ? (numberFrom(row, 'votos') / totalVotes) * 100 : 0
    }))
    .sort((left, right) => right.votes - left.votes);

  return {
    totalVotes,
    validVotes: totalVotes,
    blankVotes: numberFrom(metadata, 'brancos'),
    nullVotes: numberFrom(metadata, 'nulos'),
    electorate: numberFrom(metadata, 'eleitorado'),
    turnout: numberFrom(metadata, 'comparecimento'),
    abstention: numberFrom(metadata, 'abstencao'),
    candidates
  };
}

function buildResults() {
  const { report, verification, rows: recountRows } = readVerifiedRecount();
  const verified = Boolean(recountRows);
  const voteRows = recountRows || readCsv(path.join(ROOT, 'votos_presidente.csv'));
  const metadata = new Map(readCsv(path.join(ROOT, 'apuracao_presidente.csv'))
    .filter((row) => row.nivel === 'br' || row.nivel === 'uf')
    .map((row) => [row.nivel === 'br' ? 'BR' : row.uf, row]));
  const national = summarizeLocation(voteRows.filter((row) => row.nivel === 'br'), metadata.get('BR'));
  const locations = [...new Set(voteRows.filter((row) => row.nivel === 'uf').map((row) => row.uf))]
    .map((uf) => {
      const result = summarizeLocation(voteRows.filter((row) => row.nivel === 'uf' && row.uf === uf), metadata.get(uf));
      return { id: uf.toLowerCase(), uf, name: stateNames[uf] || uf, ...result, winner: result.candidates[0] || null };
    })
    .sort((left, right) => left.uf === 'ZZ' ? 1 : right.uf === 'ZZ' ? -1 : left.uf.localeCompare(right.uf));

  return {
    mode: verified ? 'recontagem' : 'oficial',
    generatedAt: verified ? report.generatedAt : metadata.get('BR')?.atualizado_em || null,
    source: verified
      ? `Votos por candidato recontados de ${report.decodedSections.toLocaleString('pt-BR')} boletins de urna (.dat) publicados pelo TSE. Comparecimento, brancos e nulos são os números oficiais do TSE.`
      : 'Recontagem dos boletins de urna ainda não concluída ou não verificada. Os números exibidos são os oficiais publicados pelo TSE.',
    verification: verification && {
      verified: verification.verified,
      checkedAt: verification.checkedAt,
      officialSource: verification.officialSource,
      officialUpdatedAt: verification.officialUpdatedAt,
      totals: verification.totals,
      checks: verification.checks,
      locations: verification.locations.map((item) => ({ ...item, name: stateNames[item.location] || item.location }))
    },
    national: { id: 'br', name: 'Brasil', ...national },
    locations
  };
}

module.exports = { buildResults, RECOUNT_DIR, ROOT };
