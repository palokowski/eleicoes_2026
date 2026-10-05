const express = require('express');
const path = require('path');
const { buildResults } = require('./lib/resultados');
const { downloadFiles } = require('./lib/arquivos');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));

// Mesmo caminho do site estatico (build_site.js grava dist/data/results.json).
app.get('/data/results.json', (req, res) => {
  try {
    res.json({ ...buildResults(), downloads: downloadFiles().map(({ name, label }) => ({ name, label })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível ler os resultados.', details: error.message });
  }
});

app.get('/dados/:file', (req, res) => {
  const file = downloadFiles().find((item) => item.name === req.params.file);
  if (!file) return res.status(404).end();
  res.download(file.source, file.name);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
