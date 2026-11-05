/**
 * Construit le contenu Jira (summary + description en ADF) pour un cas de test.
 *
 * L'API REST v3 de Jira Cloud attend le champ `description` en ADF
 * (Atlassian Document Format), pas en simple texte/markdown.
 * Référence : https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */

export interface JiraTestCaseSource {
  test_id: string;
  title: string;
  preconditions: string[];
  steps: string[];
  test_data: string[];
  expected_result?: string | null;
  type: string;
  priority: string;
}

export interface JiraRequirementSource {
  req_id: string;
  description: string;
}

// ── Petits constructeurs de nœuds ADF ──────────────────────────────────────
const text = (value: string) => ({ type: 'text', text: value || '—' });
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const heading = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const bulletList = (items: string[]) => ({
  type: 'bulletList',
  content: (items.length ? items : ['—']).map(item => ({
    type: 'listItem',
    content: [paragraph(item)],
  })),
});
const orderedList = (items: string[]) => ({
  type: 'orderedList',
  content: (items.length ? items : ['—']).map(item => ({
    type: 'listItem',
    content: [paragraph(item)],
  })),
});
const rule = () => ({ type: 'rule' });

export function buildJiraSummary(tc: JiraTestCaseSource, req: JiraRequirementSource): string {
  // Jira limite généralement le summary à 255 caractères
  const raw = `[${req.req_id}] ${tc.title}`;
  return raw.length > 250 ? raw.slice(0, 247) + '...' : raw;
}

export function buildJiraDescription(tc: JiraTestCaseSource, req: JiraRequirementSource) {
  const content: any[] = [
    paragraph(`Cas de test généré depuis la plateforme QA — exigence ${req.req_id}.`),
    heading(4, 'Exigence source'),
    paragraph(`${req.req_id} — ${req.description}`),
    rule(),
    heading(4, 'Préconditions'),
    bulletList(tc.preconditions || []),
    heading(4, 'Étapes'),
    orderedList(tc.steps || []),
  ];

  if (tc.test_data?.length) {
    content.push(heading(4, 'Données de test'), bulletList(tc.test_data));
  }

  content.push(
    heading(4, 'Résultat attendu'),
    paragraph(tc.expected_result || '—'),
    rule(),
    paragraph(`Type: ${tc.type}  |  Priorité: ${tc.priority}  |  ID interne: ${tc.test_id}`),
  );

  return {
    type: 'doc',
    version: 1,
    content,
  };
}

/** Labels Jira dérivés du TC — évite de dépendre d'un schéma de priorité Jira spécifique à l'instance. */
export function buildJiraLabels(tc: JiraTestCaseSource): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return ['test-case', `tc-type-${norm(tc.type)}`, `tc-priority-${norm(tc.priority)}`];
}
