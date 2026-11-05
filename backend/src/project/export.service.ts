import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

// ─── Logo de l'application ─────────────────────────────────────────────────
// Placez votre fichier logo (PNG ou JPG) à l'un de ces emplacements :
//   backend/src/assets/logo.png   (dev)
//   backend/dist/assets/logo.png  (prod — copié automatiquement si déclaré
//   dans "assets" de nest-cli.json, voir note en fin de fichier)
const LOGO_CANDIDATES = [
  path.join(__dirname, 'assets', 'logo.png'),
  path.join(__dirname, '..', 'assets', 'logo.png'),
  path.join(process.cwd(), 'src', 'assets', 'logo.png'),
];
const LOGO_PATH = LOGO_CANDIDATES.find(p => fs.existsSync(p)) ?? null;

// ─── Types (duck-typing volontaire — reflète la forme retournée par
//     ProjectService.getProject(), qui inclut modules → requirements → test_cases) ──
export interface ExportTestCase {
  test_id: string;
  title: string;
  preconditions?: string[] | null;
  steps?: string[] | null;
  test_data?: string[] | null;
  expected_result?: string | null;
  type: string;
  priority: string;
  validated?: boolean | null;
  manually_edited?: boolean;
}

export interface ExportRequirement {
  req_id: string;
  description: string;
  priority: string;
  manually_edited?: boolean;
  test_cases?: ExportTestCase[];
}

export interface ExportModule {
  name: string;
  description?: string | null;
  requirements: ExportRequirement[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const asList = (v?: string[] | null): string[] => (Array.isArray(v) ? v.filter(Boolean) : []);
const joinLines = (v?: string[] | null): string => asList(v).join('\n');
const validatedLabel = (v?: boolean | null): string =>
  v === true ? 'Validé' : v === false ? 'Rejeté' : 'En attente';

const REQ_COLUMNS_BASE = [
  { header: 'ID', key: 'req_id', width: 12 },
  { header: 'Description', key: 'description', width: 60 },
  { header: 'Priorité', key: 'priority', width: 12 },
  { header: 'Modifié manuellement', key: 'manually_edited', width: 18 },
  { header: 'Nb cas de test', key: 'tc_count', width: 14 },
];

const TC_COLUMNS_BASE = [
  { header: 'Exigence', key: 'req_id', width: 12 },
  { header: 'ID', key: 'test_id', width: 12 },
  { header: 'Titre', key: 'title', width: 30 },
  { header: 'Type', key: 'type', width: 14 },
  { header: 'Priorité', key: 'priority', width: 12 },
  { header: 'Préconditions', key: 'preconditions', width: 35 },
  { header: 'Étapes', key: 'steps', width: 45 },
  { header: 'Données de test', key: 'test_data', width: 30 },
  { header: 'Résultat attendu', key: 'expected_result', width: 40 },
  { header: 'Statut', key: 'validated', width: 14 },
];

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
const PDF_VERTICAL_SHIFT = 10;

@Injectable()
export class ExportService {
  // ══════════════════════════════════════════════════════════════════════
  // EXCEL — un seul module
  // ══════════════════════════════════════════════════════════════════════
  async buildModuleExcel(projectName: string, mod: ExportModule): Promise<Buffer> {
    const workbook = this.newWorkbook();

    const reqSheet = workbook.addWorksheet('Exigences');
    reqSheet.columns = REQ_COLUMNS_BASE;
    this.styleHeaderRow(reqSheet);
    this.addRequirementRows(reqSheet, mod);

    const tcSheet = workbook.addWorksheet('Cas de test');
    tcSheet.columns = TC_COLUMNS_BASE;
    this.styleHeaderRow(tcSheet);
    this.addTestCaseRows(tcSheet, mod);

    return this.finalizeExcel(workbook);
  }

  // ══════════════════════════════════════════════════════════════════════
  // EXCEL — projet entier (tous les modules, exigences et cas de test)
  // ══════════════════════════════════════════════════════════════════════
  async buildProjectExcel(projectName: string, modules: ExportModule[]): Promise<Buffer> {
    const workbook = this.newWorkbook();

    // ── Feuille de synthèse (créée en premier pour qu'elle apparaisse en tête) ──
    const summarySheet = workbook.addWorksheet('Synthèse', { views: [{ state: 'frozen', ySplit: 1 }] });
    summarySheet.columns = [
      { header: 'Module', key: 'module', width: 30 },
      { header: 'Nb exigences', key: 'req_count', width: 14 },
      { header: 'Nb cas de test', key: 'tc_count', width: 14 },
    ];
    this.styleHeaderRow(summarySheet);
    for (const mod of modules) {
      summarySheet.addRow({
        module: mod.name,
        req_count: mod.requirements.length,
        tc_count: mod.requirements.reduce((sum, r) => sum + (r.test_cases?.length ?? 0), 0),
      });
    }
    summarySheet.addRow({
      module: 'TOTAL',
      req_count: modules.reduce((s, m) => s + m.requirements.length, 0),
      tc_count: modules.reduce((s, m) => s + m.requirements.reduce((s2, r) => s2 + (r.test_cases?.length ?? 0), 0), 0),
    });
    summarySheet.getRow(summarySheet.rowCount).font = { bold: true };

    const reqSheet = workbook.addWorksheet('Exigences');
    reqSheet.columns = [{ header: 'Module', key: 'module', width: 22 }, ...REQ_COLUMNS_BASE];
    this.styleHeaderRow(reqSheet);
    for (const mod of modules) this.addRequirementRows(reqSheet, mod, mod.name);

    const tcSheet = workbook.addWorksheet('Cas de test');
    tcSheet.columns = [{ header: 'Module', key: 'module', width: 22 }, ...TC_COLUMNS_BASE];
    this.styleHeaderRow(tcSheet);
    for (const mod of modules) this.addTestCaseRows(tcSheet, mod, mod.name);

    return this.finalizeExcel(workbook);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PDF — un seul module
  // ══════════════════════════════════════════════════════════════════════
  async buildModulePdf(projectName: string, mod: ExportModule): Promise<Buffer> {
    return this.renderPdf(doc => {
      this.writeProjectHeader(doc, projectName, `${mod.requirements.length} exigence(s)`);
      this.writeModuleSection(doc, mod, false);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PDF — projet entier (tous les modules, exigences et cas de test)
  // ══════════════════════════════════════════════════════════════════════
  async buildProjectPdf(projectName: string, modules: ExportModule[]): Promise<Buffer> {
    const totalReqs = modules.reduce((s, m) => s + m.requirements.length, 0);
    const totalTcs = modules.reduce((s, m) => s + m.requirements.reduce((s2, r) => s2 + (r.test_cases?.length ?? 0), 0), 0);

    return this.renderPdf(doc => {
      this.writeProjectHeader(doc, projectName, `${modules.length} module(s) — ${totalReqs} exigence(s) — ${totalTcs} cas de test`);

      modules.forEach((mod, i) => {
        if (i > 0) doc.addPage();
        this.writeModuleSection(doc, mod, true);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Helpers Excel
  // ══════════════════════════════════════════════════════════════════════
  private newWorkbook(): ExcelJS.Workbook {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SpecChef';
    workbook.created = new Date();
    return workbook;
  }

  private styleHeaderRow(sheet: ExcelJS.Worksheet) {
    const row = sheet.getRow(1);
    row.fill = HEADER_FILL;
    row.font = HEADER_FONT;
  }

  private addRequirementRows(sheet: ExcelJS.Worksheet, mod: ExportModule, moduleName?: string) {
    for (const req of mod.requirements) {
      const row: Record<string, any> = {
        req_id: req.req_id,
        description: req.description,
        priority: req.priority,
        manually_edited: req.manually_edited ? 'Oui' : 'Non',
        tc_count: req.test_cases?.length ?? 0,
      };
      if (moduleName !== undefined) row.module = moduleName;
      sheet.addRow(row);
    }
    sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  }

  private addTestCaseRows(sheet: ExcelJS.Worksheet, mod: ExportModule, moduleName?: string) {
    for (const req of mod.requirements) {
      for (const tc of req.test_cases ?? []) {
        const row: Record<string, any> = {
          req_id: req.req_id,
          test_id: tc.test_id,
          title: tc.title,
          type: tc.type,
          priority: tc.priority,
          preconditions: joinLines(tc.preconditions),
          steps: joinLines(tc.steps),
          test_data: joinLines(tc.test_data),
          expected_result: tc.expected_result ?? '',
          validated: validatedLabel(tc.validated),
        };
        if (moduleName !== undefined) row.module = moduleName;
        sheet.addRow(row);
      }
    }
    sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  }

  private async finalizeExcel(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Helpers PDF
  // ══════════════════════════════════════════════════════════════════════
  private renderPdf(write: (doc: InstanceType<typeof PDFDocument>) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      write(doc);

      // ── Pagination ─────────────────────────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
          .text(`Page ${i + 1} / ${range.count}`, 50, 800, { width: 495, align: 'center' });
      }

      doc.end();
    });
  }

  private writeProjectHeader(doc: InstanceType<typeof PDFDocument>, projectName: string, subtitle: string) {
    const startY = Math.max(doc.page.margins.top, doc.y - PDF_VERTICAL_SHIFT);
    const startX = doc.x;
    const logoSize = 90;
    const pageContentWidth = 545 - startX; // largeur utile (marge gauche → marge droite)

    if (LOGO_PATH) {
      try {
        doc.image(LOGO_PATH, startX, startY, { width: logoSize, height: logoSize, fit: [logoSize, logoSize] });
      } catch {
        // Logo illisible/corrompu : on continue sans bloquer l'export.
      }
    }

    // Le nom du projet est centré sur toute la largeur de la page, sous le logo.
    const titleY = startY + logoSize + 8;
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a')
      .text(projectName, startX, titleY, { width: pageContentWidth, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#64748b')
      .text(`Généré le ${new Date().toLocaleDateString('fr-FR')} — ${subtitle}`, startX, doc.y, { width: pageContentWidth, align: 'center' });

    doc.x = startX;
    doc.moveDown(0.6);
    doc.moveTo(doc.x, doc.y).lineTo(545, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.5);
  }

  /** Écrit la section d'un module : titre, description, puis chaque exigence + ses TC. */
  private writeModuleSection(doc: InstanceType<typeof PDFDocument>, mod: ExportModule, withModuleTitle: boolean) {
    if (withModuleTitle) {
      this.ensureSpace(doc, 60);
      // Petit repère carré coloré à la place de l'emoji 📦 : les polices standard de PDFKit
      // (Helvetica) ne supportent pas les emoji Unicode et affichaient des caractères corrompus.
      const markerSize = 10;
      const leftX = doc.x;
      const titleY = doc.y;
      doc.rect(leftX, titleY + 4, markerSize, markerSize).fill('#0f766e');
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a')
        .text(mod.name, leftX + markerSize + 8, titleY);
      doc.x = leftX;
      if (mod.description) {
        doc.font('Helvetica').fontSize(10).fillColor('#64748b').text(mod.description);
      }
      doc.font('Helvetica').fontSize(9).fillColor('#94a3b8')
        .text(`${mod.requirements.length} exigence(s)`);
      doc.moveDown(0.8);
    }

    for (const req of mod.requirements) {
      this.ensureSpace(doc, 90);

      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f766e')
        .text(`${req.req_id}  —  ${req.priority}`);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a')
        .text(req.description, { width: 495 });
      doc.moveDown(0.5);

      const testCases = req.test_cases ?? [];
      if (testCases.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#94a3b8')
          .text('Aucun cas de test pour cette exigence.');
        doc.moveDown(0.8);
        continue;
      }

      for (const tc of testCases) {
        this.ensureSpace(doc, 120);

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d4ed8')
          .text(`${tc.test_id} — ${tc.title}`, { width: 495 });
        doc.font('Helvetica').fontSize(9).fillColor('#64748b')
          .text(`Type : ${tc.type}    Priorité : ${tc.priority}    Statut : ${validatedLabel(tc.validated)}`);

        const preconditions = asList(tc.preconditions);
        if (preconditions.length) {
          doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Préconditions :');
          doc.font('Helvetica').fontSize(9).fillColor('#334155');
          preconditions.forEach(p => doc.text(`•  ${p}`, { width: 495, indent: 10 }));
        }

        const steps = asList(tc.steps);
        if (steps.length) {
          doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Étapes :');
          doc.font('Helvetica').fontSize(9).fillColor('#334155');
          steps.forEach((s, i) => doc.text(`${i + 1}.  ${s}`, { width: 495, indent: 10 }));
        }

        const testData = asList(tc.test_data);
        if (testData.length) {
          doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Données de test :');
          doc.font('Helvetica').fontSize(9).fillColor('#334155');
          testData.forEach(d => doc.text(`•  ${d}`, { width: 495, indent: 10 }));
        }

        if (tc.expected_result) {
          doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Résultat attendu :');
          doc.font('Helvetica').fontSize(9).fillColor('#334155').text(tc.expected_result, { width: 495 });
        }

        doc.moveDown(0.8);
      }

      doc.moveDown(0.3);
      doc.moveTo(doc.x, doc.y).lineTo(545, doc.y).strokeColor('#f1f5f9').stroke();
      doc.moveDown(0.8);
    }
  }

  /** Force un saut de page si l'espace restant est insuffisant. */
  private ensureSpace(doc: InstanceType<typeof PDFDocument>, minHeight: number) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + minHeight > bottom) doc.addPage();
  }
}