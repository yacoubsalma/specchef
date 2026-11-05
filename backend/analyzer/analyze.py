#!/usr/bin/env python3
"""
analyze.py — Analyseur de fichiers avec Docling
Supporte : PDF, DOCX, XLSX, PPTX, TXT, CSV
Usage : python3 analyze.py <chemin_du_fichier>
"""

import sys
import json
import os
import re
import time
from pathlib import Path


def log_progress(message: str):
    print(f"[PROGRESS] {message}", file=sys.stderr, flush=True)


def get_file_meta(file_path: str) -> dict:
    stat = os.stat(file_path)
    size_bytes = stat.st_size
    ext = Path(file_path).suffix.lower().lstrip(".")
    return {
        "extension": ext,
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 2),
        "size_gb": round(size_bytes / (1024 * 1024 * 1024), 4) if size_bytes > 1024 * 1024 * 1024 else None,
        "filename": Path(file_path).name,
    }


# ============================================================
# FORMATAGE MARKDOWN — Convertit texte brut pdfplumber en Markdown propre
# ============================================================

def format_recovered_page_as_markdown(page_text: str) -> str:
    """
    Convertit le texte brut extrait par pdfplumber en Markdown structuré
    ALIGNÉ sur le format Docling pour que le LLM traite les deux de façon identique.

    Docling produit :
      ## 3.1.2. Employer Registration and Profile Management
      | FR-13. | The system SHALL allow employers... |
      |--------|--------------------------------------|

    Ce convertisseur reproduit exactement ce format.
    """
    # Nettoyage des bytes invalides fréquents dans les PDF
    cleaned = page_text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    cleaned = cleaned.replace("\x00", "").replace("\xdf", "ß")

    lines = cleaned.splitlines()
    result_lines = []
    i = 0

    # Pattern titres de sections numérotées — plus flexible :
    #   "3.1.2. Employer Registration..."
    #   "3.1.2 Employer Registration..."  (sans point final)
    #   "3. Product Functions"
    section_pattern = re.compile(
        r'^(\d+(?:\.\d+)*)\.?\s{1,4}([A-Z][^\n]{4,})$'
    )

    # Pattern exigences (FR-XX, NFR-XX, IR-XX, DR-XX, SR-XX)
    req_pattern = re.compile(
        r'^((?:FR|NFR|IR|DR|SR|UC|US)-\d+\.?)\s{1,6}(.+)'
    )

    # Pattern "ID  Requirement" (en-tête de tableau)
    table_header_pattern = re.compile(r'^ID\s{2,}Requirement', re.IGNORECASE)

    # Numéro de page seul
    page_num_pattern = re.compile(r'^\d{1,3}$')

    # Pied de page / en-tête document (patterns courants à ignorer)
    noise_pattern = re.compile(
        r'^(Page \d+|©|Copyright|Confidential|Version \d|www\.|http)', re.IGNORECASE
    )

    in_table = False  # On est en train d'émettre un tableau d'exigences

    while i < len(lines):
        line = lines[i].strip()

        if not line:
            if in_table:
                # Ligne vide = fin du tableau courant
                in_table = False
            result_lines.append('')
            i += 1
            continue

        # Ignorer les bruits
        if page_num_pattern.match(line) or noise_pattern.match(line):
            i += 1
            continue

        # ── Titre de section → ## Markdown (comme Docling) ──────────────
        m = section_pattern.match(line)
        if m:
            section_id = m.group(1)          # ex: "3.1.2"
            section_title = m.group(2).strip()
            depth = section_id.count('.') + 1  # "3"→1, "3.1"→2, "3.1.2"→3
            heading_level = min(depth + 1, 4)  # décalage +1 pour coller à Docling (## = niveau 2)
            prefix = '#' * heading_level

            # Agréger une suite de titre sur plusieurs lignes si la suivante est minuscule
            j = i + 1
            while j < len(lines):
                next_line = lines[j].strip()
                if not next_line:
                    break
                if section_pattern.match(next_line) or req_pattern.match(next_line):
                    break
                if next_line[0].islower() or next_line[0] in ('(', 'a', 'an', 'the'):
                    section_title += ' ' + next_line
                    j += 1
                else:
                    break

            if in_table:
                in_table = False
                result_lines.append('')

            result_lines.append(f'\n{prefix} {section_id}. {section_title}\n')
            i = j
            continue

        # ── En-tête de tableau "ID  Requirement" ────────────────────────
        if table_header_pattern.match(line):
            result_lines.append('\n| ID | Requirement |')
            result_lines.append('|----|-------------|')
            in_table = True
            i += 1
            continue

        # ── Exigence FR-XX / NFR-XX → ligne de tableau Docling-compatible ─
        m = req_pattern.match(line)
        if m:
            req_id = m.group(1).rstrip('.')   # "FR-13" (sans point final)
            req_text = m.group(2).strip()

            # Agréger les lignes de continuation (même exigence sur plusieurs lignes)
            j = i + 1
            while j < len(lines):
                next_line = lines[j].strip()
                if not next_line:
                    break
                if req_pattern.match(next_line) or section_pattern.match(next_line):
                    break
                if table_header_pattern.match(next_line):
                    break
                req_text += ' ' + next_line
                j += 1

            # Échapper les pipes internes pour ne pas casser le tableau Markdown
            req_text_escaped = req_text.replace('|', '\\|')

            if not in_table:
                # Ouvrir un nouveau tableau si on n'en est pas dans un
                result_lines.append('\n| ID | Requirement |')
                result_lines.append('|----|-------------|')
                in_table = True

            result_lines.append(f'| {req_id} | {req_text_escaped} |')
            i = j
            continue

        # ── Texte normal ────────────────────────────────────────────────
        if in_table:
            # Si le texte ne ressemble plus à une exigence → fermer le tableau
            in_table = False
            result_lines.append('')

        result_lines.append(line)
        i += 1

    return '\n'.join(result_lines)


# ============================================================
# EXTRACTION PAGES MANQUANTES — pdfplumber + injection propre
# ============================================================

def extract_missing_pages_text(file_path: str, docling_markdown: str) -> str:
    """
    Détecte les pages absentes du Markdown Docling et les injecte
    correctement formatées EN DEHORS de tout tableau Markdown existant.
    """
    try:
        import pdfplumber
    except ImportError:
        log_progress("pdfplumber non disponible — pages manquantes non récupérées")
        return docling_markdown

    try:
        recovered = []

        with pdfplumber.open(file_path) as pdf:
            total = len(pdf.pages)
            all_pages_text = []

            for i, page in enumerate(pdf.pages):
                try:
                    text = page.extract_text() or ""
                    # Nettoyage bytes invalides dès l'extraction
                    text = text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
                    text = text.replace("\x00", "").replace("\xdf", "ß")
                except Exception as e:
                    log_progress(f"  pdfplumber page {i+1} erreur : {e}")
                    text = ""
                all_pages_text.append(text)

            for i, page_text in enumerate(all_pages_text):
                page_num = i + 1
                if not page_text.strip():
                    continue

                # Empreinte : chercher plusieurs lignes significatives pour réduire les faux positifs
                lines = [l.strip() for l in page_text.splitlines() if len(l.strip()) >= 15]
                if not lines:
                    continue

                # Vérifier avec plusieurs empreintes pour éviter les faux positifs
                found_in_markdown = False
                for candidate in lines[:5]:
                    fingerprint = candidate[:60]
                    # Nettoyer aussi l'empreinte avant comparaison
                    fingerprint_clean = fingerprint.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
                    if fingerprint_clean in docling_markdown:
                        found_in_markdown = True
                        break

                if not found_in_markdown:
                    log_progress(f"  Page {page_num}/{total} ABSENTE du Markdown → récupération")
                    formatted = format_recovered_page_as_markdown(page_text)
                    recovered.append((page_num, i, formatted))

        if not recovered:
            log_progress("Toutes les pages sont présentes dans le Markdown Docling")
            return docling_markdown

        log_progress(f"{len(recovered)} page(s) manquante(s) récupérée(s) : {[p for p, _, _ in recovered]}")

        injected = docling_markdown

        for page_num, page_idx, formatted_text in recovered:
            block = f"\n\n<!-- Page {page_num} récupérée via pdfplumber -->\n{formatted_text}\n\n"

            anchor_found = False
            for next_idx in range(page_idx + 1, min(page_idx + 4, len(all_pages_text))):
                next_text = all_pages_text[next_idx]
                next_lines = [l.strip() for l in next_text.splitlines() if len(l.strip()) >= 15]
                if not next_lines:
                    continue

                for anchor_candidate in next_lines[:3]:
                    anchor = anchor_candidate[:60].encode("utf-8", errors="replace").decode("utf-8", errors="replace")
                    if not anchor or anchor not in injected:
                        continue

                    pos = injected.find(anchor)
                    before = injected[:pos]

                    # Remonter jusqu'à la fin du dernier bloc propre (hors tableau)
                    # Chercher la dernière ligne qui ne commence pas par | (fin de tableau)
                    last_safe_pos = _find_last_safe_injection_point(before)

                    injected = (
                        injected[:last_safe_pos]
                        + block
                        + injected[last_safe_pos:]
                    )
                    log_progress(f"  Page {page_num} injectée avant page {next_idx + 1} (hors tableau, pos={last_safe_pos})")
                    anchor_found = True
                    break
                if anchor_found:
                    break

            if not anchor_found:
                injected += block
                log_progress(f"  Page {page_num} ajoutée en fin de document")

        return injected

    except Exception as e:
        log_progress(f"Récupération pages manquantes échouée : {e}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        return docling_markdown


def _find_last_safe_injection_point(text: str) -> int:
    """
    Trouve la dernière position sûre pour injecter du Markdown
    sans casser un tableau existant (ligne ne commençant pas par |).

    Retourne l'index de caractère dans `text`.
    """
    lines = text.splitlines(keepends=True)
    
    # Parcourir depuis la fin
    pos = len(text)
    for line in reversed(lines):
        stripped = line.strip()
        # Ligne vide → position sûre
        if not stripped:
            return pos
        # Ligne de tableau → continuer à remonter
        if stripped.startswith('|') or stripped.startswith('|-'):
            pos -= len(line)
            continue
        # Ligne normale → injecter après cette ligne
        return pos

    return 0  # fallback : début du document

# ============================================================
# ANALYSEUR DOCLING — PDF, DOCX, PPTX
# ============================================================

def analyze_with_docling(file_path: str, ext: str) -> dict:
    try:
        from docling.document_converter import DocumentConverter
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import PdfFormatOption
    except ImportError:
        raise ImportError("Docling n'est pas installé. Exécutez : pip install docling")

    log_progress(f"Initialisation Docling pour .{ext}...")

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False
    pipeline_options.do_table_structure = True
    try:
        pipeline_options.table_structure_options.do_cell_matching = True
    except AttributeError:
        pass

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )

    log_progress("Conversion du document en cours...")
    start = time.time()

    result = None
    try:
        result = converter.convert(file_path)
    except Exception as e:
        err_msg = str(e)
        log_progress(f"Docling erreur fatale : {err_msg[:200]}")
        raise RuntimeError(f"docling_error: {err_msg}")

    elapsed = round(time.time() - start, 2)
    log_progress(f"Conversion terminée en {elapsed}s")

    doc = result.document

    log_progress("Export Markdown structuré...")
    try:
        markdown_content = doc.export_to_markdown()
    except Exception as e:
        log_progress(f"Export Markdown échoué : {e} — tentative export texte")
        try:
            markdown_content = doc.export_to_text()
        except Exception:
            markdown_content = ""

    if not markdown_content or len(markdown_content.strip()) < 100:
        log_progress("Markdown trop court → fallback")
        raise RuntimeError("docling_empty: contenu exporté insuffisant")

    # ── PATCH : récupérer et injecter les pages ignorées par Docling
    if ext == "pdf":
        log_progress("Vérification pages manquantes...")
        markdown_content = extract_missing_pages_text(file_path, markdown_content)

    num_pages = 0
    num_tables = 0
    num_sections = 0
    try:
        if hasattr(doc, 'pages') and doc.pages:
            num_pages = len(doc.pages)
        if hasattr(doc, 'texts'):
            for item in doc.texts:
                label = str(getattr(item, 'label', '')).lower()
                if any(k in label for k in ['section', 'heading', 'title']):
                    num_sections += 1
        if hasattr(doc, 'tables'):
            num_tables = len(doc.tables)
    except Exception:
        pass

    log_progress(f"Document : {num_pages} pages, {num_sections} sections, {num_tables} tableaux")
    log_progress(f"Markdown : {len(markdown_content)} caractères extraits")

    return {
        "type": "document",
        "full_content": markdown_content,
        "char_count": len(markdown_content),
        "num_pages": num_pages,
        "num_tables": num_tables,
        "num_sections": num_sections,
        "extraction_time_s": elapsed,
        "extractor": "docling",
    }


# ============================================================
# ANALYSEUR EXCEL / CSV
# ============================================================

def analyze_excel(file_path: str, ext: str) -> dict:
    try:
        import openpyxl
    except ImportError:
        raise ImportError("openpyxl requis : pip install openpyxl")

    log_progress(f"Analyse fichier tabulaire .{ext}...")

    if ext == "csv":
        return analyze_csv(file_path)

    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheets_data = {}
    total_rows = 0
    total_cols = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            if any(cell is not None for cell in row):
                rows.append([str(cell) if cell is not None else "" for cell in row])
        if rows:
            sheets_data[sheet_name] = rows
            total_rows += len(rows)
            total_cols = max(total_cols, max((len(r) for r in rows), default=0))

    wb.close()
    text_content = build_excel_text(sheets_data)
    log_progress(f"Excel : {len(sheets_data)} feuilles, {total_rows} lignes")

    return {
        "type": "excel",
        "full_content": sheets_data,
        "text_representation": text_content,
        "char_count": len(text_content),
        "num_sheets": len(sheets_data),
        "total_rows": total_rows,
        "total_cols": total_cols,
        "extractor": "openpyxl",
    }


def analyze_csv(file_path: str) -> dict:
    import csv
    rows = []
    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.reader(f)
        for row in reader:
            if any(cell.strip() for cell in row):
                rows.append(row)
    text_content = build_excel_text({"Sheet1": rows})
    log_progress(f"CSV : {len(rows)} lignes")
    return {
        "type": "excel",
        "full_content": {"Sheet1": rows},
        "text_representation": text_content,
        "char_count": len(text_content),
        "num_sheets": 1,
        "total_rows": len(rows),
        "extractor": "csv",
    }


def build_excel_text(sheets_data: dict) -> str:
    lines = []
    for sheet_name, rows in sheets_data.items():
        lines.append(f"\n## Feuille : {sheet_name}\n")
        for row in rows[:500]:
            lines.append(" | ".join(str(c) for c in row))
    return "\n".join(lines)


# ============================================================
# ANALYSEUR TEXTE BRUT
# ============================================================

def analyze_text(file_path: str, ext: str) -> dict:
    log_progress(f"Lecture fichier texte .{ext}...")
    encodings = ["utf-8", "utf-8-sig", "latin-1", "cp1252"]
    content = None
    for enc in encodings:
        try:
            with open(file_path, "r", encoding=enc, errors="strict") as f:
                content = f.read()
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if content is None:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    log_progress(f"Texte : {len(content)} caractères")
    return {
        "type": "text",
        "full_content": content,
        "char_count": len(content),
        "line_count": content.count("\n"),
        "extractor": "native",
    }


# ============================================================
# FALLBACK PDF
# ============================================================

def analyze_pdf_fallback(file_path: str, reason: str = "") -> dict:
    if reason:
        log_progress(f"Raison fallback : {reason[:150]}")

    try:
        import pdfplumber
        log_progress("Fallback → pdfplumber")
        pages_text = []
        with pdfplumber.open(file_path) as pdf:
            total = len(pdf.pages)
            for i, page in enumerate(pdf.pages):
                try:
                    text = page.extract_text() or ""
                    pages_text.append(text)
                except Exception as pe:
                    log_progress(f"  Page {i+1}/{total} ignorée : {pe}")
                    pages_text.append("")
        content = "\n\n".join(p for p in pages_text if p.strip())
        if content.strip():
            log_progress(f"pdfplumber : {len(content)} chars extraits")
            return {
                "type": "document",
                "full_content": content,
                "char_count": len(content),
                "num_pages": len(pages_text),
                "extractor": "pdfplumber",
            }
    except ImportError:
        log_progress("pdfplumber non installé")
    except Exception as e:
        log_progress(f"pdfplumber échec : {e}")

    try:
        from pypdf import PdfReader
        log_progress("Fallback → pypdf")
        reader = PdfReader(file_path)
        pages_text = []
        total = len(reader.pages)
        for i, page in enumerate(reader.pages):
            try:
                pages_text.append(page.extract_text() or "")
            except Exception as pe:
                log_progress(f"  Page {i+1}/{total} ignorée : {pe}")
                pages_text.append("")
        content = "\n\n".join(p for p in pages_text if p.strip())
        if content.strip():
            log_progress(f"pypdf : {len(content)} chars extraits")
            return {
                "type": "document",
                "full_content": content,
                "char_count": len(content),
                "num_pages": len(pages_text),
                "extractor": "pypdf",
            }
    except ImportError:
        log_progress("pypdf non installé")
    except Exception as e:
        log_progress(f"pypdf échec : {e}")

    try:
        import subprocess
        log_progress("Fallback → pdftotext")
        result = subprocess.run(
            ["pdftotext", "-layout", file_path, "-"],
            capture_output=True, timeout=60
        )
        content = result.stdout.decode("utf-8", errors="replace")
        if content.strip():
            log_progress(f"pdftotext : {len(content)} chars extraits")
            return {
                "type": "document",
                "full_content": content,
                "char_count": len(content),
                "extractor": "pdftotext",
            }
    except Exception as e:
        log_progress(f"pdftotext échec : {e}")

    raise RuntimeError(
        "Aucun extracteur PDF disponible. "
        "Installez : pip install docling pdfplumber pypdf"
    )


# ============================================================
# ROUTEUR PRINCIPAL
# ============================================================

def analyze_file(file_path: str) -> dict:
    ext = Path(file_path).suffix.lower().lstrip(".")
    log_progress(f"Démarrage analyse : {Path(file_path).name} (.{ext})")

    if ext in ("pdf", "docx", "doc", "pptx", "ppt"):
        try:
            return analyze_with_docling(file_path, ext)
        except ImportError:
            log_progress("Docling absent")
            if ext == "pdf":
                return analyze_pdf_fallback(file_path, "docling_not_installed")
            raise RuntimeError(f"Docling requis pour .{ext} : pip install docling")
        except RuntimeError as e:
            log_progress(f"Docling a échoué : {str(e)[:100]}")
            if ext == "pdf":
                return analyze_pdf_fallback(file_path, str(e))
            raise

    elif ext in ("xlsx", "xls", "xlsm", "csv"):
        return analyze_excel(file_path, ext)

    elif ext in ("txt", "md", "rst", "log", "json", "xml", "yaml", "yml"):
        return analyze_text(file_path, ext)

    else:
        log_progress(f"Extension inconnue (.{ext}) — tentative lecture texte")
        return analyze_text(file_path, ext)


# ============================================================
# POINT D'ENTRÉE
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage : python3 analyze.py <chemin_fichier>"}))
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.exists(file_path):
        print(json.dumps({"error": f"Fichier introuvable : {file_path}"}))
        sys.exit(1)

    try:
        meta = get_file_meta(file_path)
        log_progress(f"Fichier : {meta['filename']} ({meta['size_mb']} MB)")

        start_total = time.time()
        content = analyze_file(file_path)
        total_elapsed = round(time.time() - start_total, 2)

        output = {
            **meta,
            "content": content,
            "processing_info": {
                "file_size_mb": meta["size_mb"],
                "is_large_file": meta["size_mb"] > 100,
                "is_very_large_file": meta["size_mb"] > 500,
                "processing_time": __import__("datetime").datetime.now().isoformat(),
                "total_elapsed_s": total_elapsed,
                "extractor_used": content.get("extractor", "unknown"),
            },
        }

        log_progress(f"Analyse terminée en {total_elapsed}s — {content.get('char_count', 0)} caractères extraits")
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        log_progress(f"Erreur fatale : {str(e)}")
        print(json.dumps({"error": str(e), "file": file_path}))
        sys.exit(1)