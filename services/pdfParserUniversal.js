// services/pdfParserUniversal.js
// Parser Universal 2.0 — Multi-banco, datas persistentes, detecção de crédito/débito

import fs from "fs";
import pdf from "pdf-parse";
import XLSX from "xlsx";

/* ============================================================
🔧 Funções auxiliares
============================================================ */
export function normalizarData(dataBruta) {
  if (!dataBruta) return new Date().toISOString().split("T")[0];
  try {
    const partes = dataBruta.trim().split("/");
    if (partes.length === 3) {
      let [dia, mes, ano] = partes.map((p) => p.padStart(2, "0"));
      if (ano.length === 2) {
        const anoNum = parseInt(ano, 10);
        ano = anoNum < 50 ? `20${ano}` : `19${ano}`;
      }
      return `${ano}-${mes}-${dia}`;
    }
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

// Limpa o texto removendo espaços e símbolos redundantes
function limparTexto(txt) {
  return txt.replace(/\s+/g, " ").replace(/\t/g, " ").trim();
}

// Detecta o banco no texto do extrato
function detectarBanco(texto) {
  const lower = texto.toLowerCase();
  if (lower.includes("bradesco")) return "bradesco";
  if (lower.includes("itaú") || lower.includes("itau")) return "itau";
  if (lower.includes("santander")) return "santander";
  if (lower.includes("nubank")) return "nubank";
  if (lower.includes("inter")) return "inter";
  if (lower.includes("banco do brasil")) return "bb";
  if (lower.includes("caixa")) return "caixa";
  return "generico";
}

// Detecta se o texto indica crédito (entrada) ou débito (saída)
function detectarTipoLinha(line) {
  const lower = line.toLowerCase();
  if (
    lower.includes("cred") ||
    lower.includes("depósito") ||
    lower.includes("receb") ||
    lower.includes("pix recebido")
  )
    return "entrada";
  if (
    lower.includes("deb") ||
    lower.includes("pagamento") ||
    lower.includes("saque") ||
    lower.includes("pix enviado") ||
    lower.includes("compra") ||
    lower.includes("tarifa")
  )
    return "saida";
  return null; // indefinido
}

// Extrai o valor certo da linha (ignora saldo quando há 2 valores)
function extrairValor(line) {
  const matches = line.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g);
  if (!matches) return null;

  // Se tiver 2 valores, geralmente o primeiro é transação e o segundo é saldo
  const valorStr = matches.length === 1 ? matches[0] : matches[0];
  const valor = parseFloat(valorStr.replace(/\./g, "").replace(",", "."));
  return valor;
}

/* ============================================================
🧩 Parser Universal aprimorado
============================================================ */
export async function parseExtratoUniversal(filePath, mimetype = "application/pdf") {
  let text = "";

  // 1️⃣ Ler o arquivo (PDF, XLSX, CSV)
  if (mimetype === "application/pdf") {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdf(buffer);
    text = pdfData.text;
  } else if (
    mimetype === "application/vnd.ms-excel" ||
    mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    text = XLSX.utils.sheet_to_csv(sheet);
  } else {
    text = fs.readFileSync(filePath, "utf8");
  }

  const banco = detectarBanco(text);
  console.log(`🏦 Banco detectado: ${banco}`);

  // 2️⃣ Quebrar em linhas e limpar
  const lines = text.split("\n").map((l) => limparTexto(l)).filter(Boolean);

  const transacoes = [];
  let currentDate = null;

  // 3️⃣ Processar linha a linha
  for (const line of lines) {
    // Detectar data
    const dataMatch = line.match(/\b(\d{2}\/\d{2}\/\d{2,4})\b/);
    if (dataMatch) currentDate = normalizarData(dataMatch[1]);

    // Detectar valor
    const valor = extrairValor(line);
    if (valor !== null) {
      const tipo = detectarTipoLinha(line) || (line.includes("-") ? "saida" : "entrada");

      const descricao = line
        .replace(dataMatch?.[1] || "", "")
        .replace(/\d{1,3}(?:\.\d{3})*,\d{2}/g, "")
        .trim();

      transacoes.push({
        data: currentDate || new Date().toISOString().split("T")[0],
        descricao: descricao || "Transação",
        valor: valor,
        tipo,
      });
    }
  }

  // 4️⃣ Remover duplicadas / linhas inválidas
  const filtradas = transacoes.filter(
    (t, i, arr) =>
      t.data &&
      !isNaN(t.valor) &&
      arr.findIndex((x) => x.data === t.data && x.descricao === t.descricao && x.valor === t.valor) === i
  );

  return { banco, transacoes: filtradas };
}
