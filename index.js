import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { OpenAI } from 'openai';
import pdfjsLib from 'pdfjs-dist';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Thiết lập Node.js environment cho pdfjs-dist
pdfjsLib.isNodeJS = true;
pdfjsLib.createCanvas = function(width, height) {
  return { width, height };
};

const app = express();
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

// Hàm gọi OpenAI để trích xuất các chuỗi cần kiểm tra từ prompt
async function extractKeywordsFromPrompt(prompt) {
  const systemPrompt =
    'Bạn là một trợ lý AI. Hãy đọc prompt sau và trả về một mảng JSON các chuỗi cần kiểm tra trong file PDF. Chỉ trả về mảng JSON, không giải thích.';
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  });
  // Tìm mảng JSON trong response
  const content = response.choices[0].message.content;
  try {
    const jsonMatch = content.match(/\[.*\]/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {}
  return [];
}

// Hàm kiểm tra giữ/xoá trang
function shouldKeepPage(pageIndex, text, keywords, prompt) {
  // Giữ nguyên page 1 và 2 (index 0,1)
  if (pageIndex === 0 || pageIndex === 1) return true;
  // Các page còn lại giữ nếu chứa 1 trong các keywords
  return keywords.some((keyword) => text.includes(keyword));
}

// Hàm extract text từng trang bằng pdfjs-dist
async function extractTextByPage(dataBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: dataBuffer });
  const pdfDocument = await loadingTask.promise;
  const numPages = pdfDocument.numPages;
  const pageTexts = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    pageTexts.push(pageText);
  }
  return pageTexts;
}

app.post('/process-pdf', upload.single('pdf'), async (req, res) => {
  try {
    const prompt = req.body.prompt;
    const pdfPath = req.file.path;
    if (!prompt || !pdfPath) {
      return res.status(400).json({ error: 'Missing prompt or PDF file.' });
    }

    // 1. Gọi OpenAI để lấy danh sách chuỗi cần kiểm tra
    const keywords = await extractKeywordsFromPrompt(prompt);

    // 2. Đọc file PDF và extract text từng trang
    const dataBuffer = fs.readFileSync(pdfPath);
    const pageTexts = await extractTextByPage(dataBuffer);

    // Đọc lại PDF bằng pdf-lib để thao tác trang
    const pdfDoc = await PDFDocument.load(dataBuffer);
    const totalPages = pdfDoc.getPageCount();
    const pagesToKeep = [];

    for (let i = 0; i < totalPages; i++) {
      const text = pageTexts[i] || '';
      if (shouldKeepPage(i, text, keywords, prompt)) {
        pagesToKeep.push(i);
      }
    }

    // 3. Tạo file PDF mới chỉ với các trang cần giữ
    const newPdfDoc = await PDFDocument.create();
    for (const pageIndex of pagesToKeep) {
      const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [pageIndex]);
      newPdfDoc.addPage(copiedPage);
    }
    const newPdfBytes = await newPdfDoc.save();

    // Xoá file upload tạm
    fs.unlinkSync(pdfPath);

    // 4. Trả file PDF kết quả
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=output.pdf');
    res.send(Buffer.from(newPdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
