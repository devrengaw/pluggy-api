// services/pdfParserUniversal.js
// Parser universal de extratos bancários (PDF / CSV / XLSX) — FinanceFlow

import fs from "fs";
import pdf from "pdf-parse";
import XLSX from "xlsx";

/* ============================================================
🔧 Funções auxiliares
============================================================ */

// Converte data brasileira dd/mm/aa → YYYY-MM-DD
function normalizarData(dataBruta) {
  try {
    const partes = dataBruta.split("/");
    let [dia, mes, ano] = partes;
    if (ano.length === 2) ano = `20${ano}`;
    return `${ano}-${mes}-${dia}`;
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

// Extrai primeiro valor monetário encontrado
function parseValor(texto) {
  const match = texto.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (!match) return null;
  const valor = parseFloat(match[1].replace(/\./g, "").replace(",", "."));
  return valor;
}

// Detecta o banco com base no texto
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

// Classifica tipo de transação com base no texto
function detectarTipo(texto, valor) {
  const lower = texto.toLowerCase();
  if (lower.includes("depósito") || lower.includes("crédito") || lower.includes("receb") || lower.includes("pix recebido"))
    return "entrada";
  if (lower.includes("débito") || lower.includes("pago") || lower.includes("pix enviado") || lower.includes("compra"))
    return "saida";
  if (valor < 0) return "saida";
  return "saida"; // padrão
}

/* ============================================================
🧩 Parser Universal
============================================================ */

export async function parseExtratoUniversal(filePath, mimetype = "application/pdf") {
  let text = "";

  // 🔹 1. Ler o arquivo conforme o tipo
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

  // 🔹 2. Detectar o banco
  const banco = detectarBanco(text);
  console.log(`🏦 Banco detectado: ${banco}`);

  // 🔹 3. Quebrar em linhas
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const transacoes = [];
  let currentDate = null;

  // 🔹 4. Ler linha por linha procurando datas e valores
  for (const line of lines) {
    const dataMatch = line.match(/\b(\d{2}\/\d{2}\/\d{2,4})\b/);
    if (dataMatch) currentDate = normalizarData(dataMatch[1]);

    const valor = parseValor(line);
    if (valor !== null && currentDate) {
      const descricao = line
        .replace(dataMatch?.[1] || "", "")
        .replace(/(\d{1,3}(?:\.\d{3})*,\d{2})/, "")
        .trim();

      const tipo = detectarTipo(line, valor);

      transacoes.push({
        data: currentDate,
        descricao: descricao || "Transação",
        valor: Math.abs(valor),
        tipo,
        categoria: null,
      });
    }
  }

  // 🔹 5. Retornar resultados
  return { banco, transacoes };
}
