#!/usr/bin/env python3
"""
Apuracao para Presidente - Eleicoes 2026 - por Brasil, UF e municipio.

Le os arquivos publicos de resultado do TSE (resultado unificado, EA20),
grava dois CSVs e, se configurado, envia tudo para o Supabase.

Uso:
  pip install requests
  python apuracao_presidente.py                  # Brasil + UFs + todos os municipios
  python apuracao_presidente.py --ufs SC,PR      # so alguns estados
  python apuracao_presidente.py --sem-municipios # so Brasil e UFs (30 requisicoes)
  python apuracao_presidente.py --loop 300       # repete a cada 5 minutos

Supabase (opcional): defina as variaveis de ambiente
  SUPABASE_URL          ex.: https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  chave service_role (nunca coloque no site)
"""
import argparse
import csv
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

CARGO_PRESIDENTE = "0001"
# Codigos da eleicao federal usados se a descoberta automatica falhar.
ELEICAO_PADRAO = {1: "6257", 2: "6258"}
EXTERIOR = "ZZ"
MAX_REQ_POR_SEGUNDO = 20  # o TSE informa limite de 100/s por IP; ficamos bem abaixo

sessao = requests.Session()
sessao.headers["User-Agent"] = "apuracao-presidente/1.0"
_trava = threading.Lock()
_ultimo = [0.0]


def baixar_json(url):
    """Baixa um JSON respeitando o limite de requisicoes. Devolve None se nao existir."""
    with _trava:
        espera = _ultimo[0] + 1.0 / MAX_REQ_POR_SEGUNDO - time.monotonic()
        if espera > 0:
            time.sleep(espera)
        _ultimo[0] = time.monotonic()
    for tentativa in range(3):
        try:
            r = sessao.get(url, timeout=30)
            if r.status_code in (403, 404):
                return None
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError):
            time.sleep(2 * (tentativa + 1))
    return None


def inteiro(v):
    """'1.234' -> 1234 (o TSE envia numeros como texto em pt-BR)."""
    try:
        return int(str(v).replace(".", "").split(",")[0] or 0)
    except ValueError:
        return 0


def decimal(v):
    """'12,34' -> 12.34"""
    try:
        return float(str(v).replace(".", "").replace(",", "."))
    except ValueError:
        return 0.0


def percorrer(no):
    """Visita todos os dicionarios de um JSON, em qualquer profundidade."""
    if isinstance(no, dict):
        yield no
        for v in no.values():
            yield from percorrer(v)
    elif isinstance(no, list):
        for v in no:
            yield from percorrer(v)


def descobrir_eleicao(base, turno):
    """Procura no ele-c.json a eleicao do turno que tem o cargo de Presidente."""
    cfg = baixar_json(f"{base}/comum/config/ele-c.json")
    for d in percorrer(cfg or {}):
        if "cd" in d and "abr" in d and str(d.get("t", "")) == str(turno):
            cargos = {str(c.get("cd", "")).lstrip("0") for a in percorrer(d["abr"])
                      for c in a.get("cp", []) if isinstance(c, dict)}
            if "1" in cargos:
                return str(d["cd"])
    print("Aviso: nao achei a eleicao no ele-c.json; usando o codigo padrao.")
    return ELEICAO_PADRAO[turno]


def listar_municipios(raiz, ele6):
    """Devolve {UF: [(codigo, nome), ...]} a partir do arquivo de municipios (EA12)."""
    cm = baixar_json(f"{raiz}/config/mun-e{ele6}-cm.json")
    ufs = {}
    for d in percorrer(cm or {}):
        if isinstance(d.get("mu"), list) and d.get("cd"):
            ufs[str(d["cd"]).upper()] = [
                (str(m["cd"]), m.get("nm", "")) for m in d["mu"] if m.get("cd")]
    return ufs


def candidatos(no, partido=""):
    """Acha os candidatos em qualquer ponto do JSON, levando a sigla do partido."""
    if isinstance(no, dict):
        partido = no.get("sg", partido)
        if "vap" in no and "n" in no and "nm" in no:
            yield no, partido
        for v in no.values():
            yield from candidatos(v, partido)
    elif isinstance(no, list):
        for v in no:
            yield from candidatos(v, partido)


def interpretar(dados, turno, nivel, uf, cd_mun, nome):
    """Transforma um arquivo de resultado em linhas de votos + 1 linha de apuracao."""
    agora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    chave = {"turno": turno, "nivel": nivel, "uf": uf, "cd_municipio": cd_mun,
             "municipio": nome}
    votos = {}
    for c, partido in candidatos(dados):
        numero = inteiro(c["n"])
        votos[numero] = {**chave, "numero": numero, "candidato": c["nm"],
                         "partido": partido, "votos": inteiro(c["vap"]),
                         "pct_validos": decimal(c.get("pvap", 0)),
                         "atualizado_em": agora}
    s, e, v = (dados.get(k) or {} for k in ("s", "e", "v"))
    apur = {**chave, "pct_secoes": decimal(s.get("pst", 0)),
            "eleitorado": inteiro(e.get("te", 0)),
            "comparecimento": inteiro(e.get("c", 0)),
            "abstencao": inteiro(e.get("a", 0)),
            "validos": inteiro(v.get("vv", 0)), "brancos": inteiro(v.get("vb", 0)),
            "nulos": inteiro(v.get("tvn", v.get("vn", 0))), "atualizado_em": agora}
    return list(votos.values()), apur


def coletar(args):
    base = f"{args.base}/{args.ambiente}"
    eleicao = args.eleicao or descobrir_eleicao(base, args.turno)
    ele6 = eleicao.zfill(6)
    raiz = f"{base}/{args.ciclo}/{eleicao}"
    print(f"Eleicao {eleicao} ({args.turno}o turno)")

    municipios = listar_municipios(raiz, ele6)
    if not municipios:
        sys.exit("Nao consegui ler a lista de municipios do TSE. Tente de novo em instantes.")
    ufs = [u for u in sorted(municipios) if u != "BR"]
    if args.ufs:
        pedido = {u.strip().upper() for u in args.ufs.split(",")}
        ufs = [u for u in ufs if u in pedido]

    def arquivo(pasta, prefixo):
        return f"{raiz}/dados/{pasta}/{prefixo}-c{CARGO_PRESIDENTE}-e{ele6}-u.json"

    tarefas = [] if args.ufs else [("br", "BR", "", "BRASIL", arquivo("br", "br"))]
    for uf in ufs:
        u = uf.lower()
        tarefas.append(("uf", uf, "", "EXTERIOR" if uf == EXTERIOR else uf, arquivo(u, u)))
        if not args.sem_municipios:
            for cd, nm in municipios[uf]:
                tarefas.append(("mu", uf, cd, nm, arquivo(u, u + cd)))

    def uma(t):
        nivel, uf, cd, nm, url = t
        dados = baixar_json(url)
        return interpretar(dados, args.turno, nivel, uf, cd, nm) if dados else None

    linhas_votos, linhas_apur, vazios = [], [], 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, res in enumerate(pool.map(uma, tarefas), 1):
            if res and res[0]:
                linhas_votos += res[0]
                linhas_apur.append(res[1])
            else:
                vazios += 1
            if i % 500 == 0:
                print(f"  {i}/{len(tarefas)} arquivos")
    print(f"{len(tarefas) - vazios} localidades com resultado, {vazios} ainda sem dados")
    return linhas_votos, linhas_apur


def gravar_csv(caminho, linhas):
    if not linhas:
        return
    with open(caminho, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(linhas[0]), delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    print(f"Gravado {caminho} ({len(linhas)} linhas)")


def enviar_supabase(tabela, linhas, conflito):
    url, chave = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not (url and chave and linhas):
        return
    cab = {"apikey": chave, "Authorization": f"Bearer {chave}",
           "Content-Type": "application/json",
           "Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(linhas), 1000):
        r = requests.post(f"{url}/rest/v1/{tabela}", params={"on_conflict": conflito},
                          headers=cab, json=linhas[i:i + 1000], timeout=60)
        if r.status_code >= 300:
            sys.exit(f"Erro do Supabase em {tabela}: {r.status_code} {r.text[:300]}")
    print(f"Supabase: {len(linhas)} linhas em {tabela}")


def main():
    p = argparse.ArgumentParser(description="Apuracao para Presidente por UF e municipio")
    p.add_argument("--turno", type=int, choices=[1, 2], default=1)
    p.add_argument("--eleicao", help="codigo da eleicao no TSE (descoberto sozinho se omitido)")
    p.add_argument("--ufs", help="lista de UFs, ex.: SC,PR (ZZ = exterior)")
    p.add_argument("--sem-municipios", action="store_true", help="so Brasil e UFs")
    p.add_argument("--loop", type=int, default=0, help="repete a cada N segundos")
    p.add_argument("--base", default="https://resultados.tse.jus.br")
    p.add_argument("--ambiente", default="oficial")
    p.add_argument("--ciclo", default="ele2026")
    p.add_argument("--saida", default=".", help="pasta onde gravar os CSVs (padrao: pasta atual)")
    args = p.parse_args()
    os.makedirs(args.saida, exist_ok=True)

    while True:
        votos, apur = coletar(args)
        gravar_csv(os.path.join(args.saida, "votos_presidente.csv"), votos)
        gravar_csv(os.path.join(args.saida, "apuracao_presidente.csv"), apur)
        chave = "turno,nivel,uf,cd_municipio"
        enviar_supabase("votos_presidente", votos, chave + ",numero")
        enviar_supabase("apuracao_presidente", apur, chave)
        if not args.loop:
            break
        print(f"Aguardando {args.loop}s...\n")
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
