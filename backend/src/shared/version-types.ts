// ============================================================================
// Types/constantes partagés pour le versioning & historique (rollback).
// Utilisé par ProjectService (Requirement, RequirementModule, TestCase) et
// WorkflowService (TestWorkflow) — voir VersionsService pour la persistance.
// ============================================================================

export const VERSIONED_ENTITY = {
  MODULE: 'requirement_module',
  REQUIREMENT: 'requirement',
  TEST_CASE: 'test_case',
  WORKFLOW: 'test_workflow',
} as const;

export type VersionedEntityType = typeof VERSIONED_ENTITY[keyof typeof VERSIONED_ENTITY];

export const VERSIONED_ENTITY_TYPES: VersionedEntityType[] = Object.values(VERSIONED_ENTITY);

export function isVersionedEntityType(value: string): value is VersionedEntityType {
  return (VERSIONED_ENTITY_TYPES as string[]).includes(value);
}

// Libellés FR pour construire des `change_summary` lisibles à partir des noms
// de champs Prisma modifiés (ex: "description, priorité modifiées").
export const FIELD_LABELS: Record<string, string> = {
  req_id: "l'identifiant",
  description: 'la description',
  priority: 'la priorité',
  name: 'le nom',
  title: 'le titre',
  steps: 'les étapes',
  preconditions: 'les préconditions',
  test_data: 'les données de test',
  expected_result: 'le résultat attendu',
  type: 'le type',
  nodes: 'le graphe (étapes)',
  edges: 'le graphe (liaisons)',
  variables: 'les variables',
};

/** Compare deux objets (mêmes clés attendues) et retourne un résumé FR des champs qui diffèrent. */
export function summarizeChanges(before: Record<string, any>, after: Record<string, any>): string {
  const changed: string[] = [];
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    const beforeVal = JSON.stringify(before?.[key] ?? null);
    const afterVal = JSON.stringify(after[key] ?? null);
    if (beforeVal !== afterVal) changed.push(FIELD_LABELS[key] ?? key);
  }
  if (changed.length === 0) return 'Mise à jour';
  return changed.length === 1 ? `${changed[0]} modifiée` : `${changed.join(', ')} modifiés`;
}