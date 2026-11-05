/**
 * Construction du contenu Confluence (format "storage", XHTML) pour la page
 * d'aperçu du projet : un tableau d'exigences par module.
 */

export interface ConfluenceModuleData {
  name: string;
  description?: string | null;
  requirements: Array<{
    req_id: string;
    description: string;
    priority: string;
  }>;
}

function escapeXml(value: string): string {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Construit le corps (storage format) de la page d'aperçu du projet Anayzer. */
export function buildProjectOverviewStorage(
  projectName: string,
  documentType: string | null | undefined,
  modules: ConfluenceModuleData[],
): string {
  const totalReqs = modules.reduce((sum, m) => sum + m.requirements.length, 0);

  const intro = `
    <p>
      <strong>Projet :</strong> ${escapeXml(projectName)}<br/>
      ${documentType ? `<strong>Type de document :</strong> ${escapeXml(documentType)}<br/>` : ''}
      <strong>Modules :</strong> ${modules.length}
      &nbsp;·&nbsp;
      <strong>Exigences :</strong> ${totalReqs}
    </p>
    <p><em>Page générée automatiquement par SpecChef lors de l'extraction du document SRS.</em></p>
    <hr/>
  `;

  const sections = modules
    .map(mod => {
      const rows = mod.requirements
        .map(
          req => `
        <tr>
          <td><p>${escapeXml(req.req_id)}</p></td>
          <td><p>${escapeXml(req.description)}</p></td>
          <td><p>${escapeXml(req.priority)}</p></td>
        </tr>`,
        )
        .join('');

      const table = mod.requirements.length
        ? `
        <table>
          <thead>
            <tr>
              <th><p>ID</p></th>
              <th><p>Description</p></th>
              <th><p>Priorité</p></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<p><em>Aucune exigence dans ce module.</em></p>`;

      return `
        <h2>${escapeXml(mod.name)}</h2>
        ${mod.description ? `<p>${escapeXml(mod.description)}</p>` : ''}
        ${table}
      `;
    })
    .join('\n');

  return `${intro}${sections}`;
}