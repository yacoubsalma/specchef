/**
 * Backfill du versioning pour les données existantes (créées avant l'ajout
 * de EntityVersion / du champ `version` sur Requirement, RequirementModule,
 * TestCase, TestWorkflow).
 *
 * Ce que fait ce script, pour chacune des 4 collections :
 *   1) Si `version` est absent en base → le fixe à 1 (update Mongo direct,
 *      car Prisma ne peut pas "trouver" un doc dont un champ requis manque
 *      autrement qu'en le traitant comme undefined — on passe par le driver
 *      Mongo brut via `$runCommandRaw` pour ce cas précis).
 *   2) Si AUCUNE entrée EntityVersion n'existe encore pour cette entité →
 *      crée une entrée `change_type: 'create'`, `version_number: 1`, avec
 *      l'état actuel comme snapshot de baseline. Sans ça, l'historique d'une
 *      entité ancienne resterait vide tant qu'elle n'est pas modifiée une
 *      première fois après le déploiement.
 *
 * Idempotent : peut être relancé sans dupliquer les entrées (skip si une
 * version existe déjà pour l'entité).
 *
 * Usage :
 *   cd backend && npx ts-node scripts/backfill-versions.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ENTITY_TYPE = {
  MODULE: 'requirement_module',
  REQUIREMENT: 'requirement',
  TEST_CASE: 'test_case',
  WORKFLOW: 'test_workflow',
} as const;

async function backfillModules() {
  const modules = await prisma.requirementModule.findMany({ select: { id: true, project_id: true, name: true, description: true, version: true } });
  let created = 0, fixed = 0;
  for (const mod of modules) {
    if (mod.version == null) {
      await prisma.requirementModule.update({ where: { id: mod.id }, data: { version: 1 } });
      fixed++;
    }
    const already = await prisma.entityVersion.findFirst({ where: { entity_type: ENTITY_TYPE.MODULE, entity_id: mod.id } });
    if (already) continue;
    await prisma.entityVersion.create({
      data: {
        project_id: mod.project_id,
        entity_type: ENTITY_TYPE.MODULE,
        entity_id: mod.id,
        version_number: 1,
        snapshot: { name: mod.name, description: mod.description },
        change_type: 'create',
        change_summary: 'État initial (backfill — module créé avant l\'introduction du versioning)',
      },
    });
    created++;
  }
  console.log(`✅ RequirementModule — version corrigée: ${fixed}, historique de baseline créé: ${created}/${modules.length}`);
}

async function backfillRequirements() {
  const reqs = await prisma.requirement.findMany({
    select: { id: true, req_id: true, description: true, priority: true, version: true, module: { select: { project_id: true } } },
  });
  let created = 0, fixed = 0;
  for (const req of reqs) {
    if (req.version == null) {
      await prisma.requirement.update({ where: { id: req.id }, data: { version: 1 } });
      fixed++;
    }
    const already = await prisma.entityVersion.findFirst({ where: { entity_type: ENTITY_TYPE.REQUIREMENT, entity_id: req.id } });
    if (already) continue;
    await prisma.entityVersion.create({
      data: {
        project_id: req.module.project_id,
        entity_type: ENTITY_TYPE.REQUIREMENT,
        entity_id: req.id,
        version_number: 1,
        snapshot: { req_id: req.req_id, description: req.description, priority: req.priority },
        change_type: 'create',
        change_summary: 'État initial (backfill — exigence créée avant l\'introduction du versioning)',
      },
    });
    created++;
  }
  console.log(`✅ Requirement — version corrigée: ${fixed}, historique de baseline créé: ${created}/${reqs.length}`);
}

async function backfillTestCases() {
  const tcs = await prisma.testCase.findMany({
    select: {
      id: true, title: true, steps: true, preconditions: true, test_data: true,
      expected_result: true, type: true, priority: true, version: true,
      requirement: { select: { module: { select: { project_id: true } } } },
    },
  });
  let created = 0, fixed = 0;
  for (const tc of tcs) {
    if (tc.version == null) {
      await prisma.testCase.update({ where: { id: tc.id }, data: { version: 1 } });
      fixed++;
    }
    const already = await prisma.entityVersion.findFirst({ where: { entity_type: ENTITY_TYPE.TEST_CASE, entity_id: tc.id } });
    if (already) continue;
    await prisma.entityVersion.create({
      data: {
        project_id: tc.requirement.module.project_id,
        entity_type: ENTITY_TYPE.TEST_CASE,
        entity_id: tc.id,
        version_number: 1,
        snapshot: { title: tc.title, steps: tc.steps, preconditions: tc.preconditions, test_data: tc.test_data, expected_result: tc.expected_result, type: tc.type, priority: tc.priority },
        change_type: 'create',
        change_summary: 'État initial (backfill — cas de test créé avant l\'introduction du versioning)',
      },
    });
    created++;
  }
  console.log(`✅ TestCase — version corrigée: ${fixed}, historique de baseline créé: ${created}/${tcs.length}`);
}

async function backfillWorkflows() {
  const flows = await prisma.testWorkflow.findMany({ select: { id: true, project_id: true, name: true, description: true, nodes: true, edges: true, variables: true, version: true } });
  let created = 0, fixed = 0;
  for (const flow of flows) {
    if (flow.version == null) {
      await prisma.testWorkflow.update({ where: { id: flow.id }, data: { version: 1 } });
      fixed++;
    }
    const already = await prisma.entityVersion.findFirst({ where: { entity_type: ENTITY_TYPE.WORKFLOW, entity_id: flow.id } });
    if (already) continue;
    await prisma.entityVersion.create({
      data: {
        project_id: flow.project_id,
        entity_type: ENTITY_TYPE.WORKFLOW,
        entity_id: flow.id,
        version_number: 1,
        snapshot: { name: flow.name, description: flow.description, nodes: flow.nodes, edges: flow.edges, variables: flow.variables },
        change_type: 'create',
        change_summary: 'État initial (backfill — workflow créé avant l\'introduction du versioning)',
      },
    });
    created++;
  }
  console.log(`✅ TestWorkflow — version corrigée: ${fixed}, historique de baseline créé: ${created}/${flows.length}`);
}

async function main() {
  console.log('🚀 Backfill du versioning — démarrage...');
  await backfillModules();
  await backfillRequirements();
  await backfillTestCases();
  await backfillWorkflows();
  console.log('🏁 Backfill terminé.');
}

main()
  .catch((err) => {
    console.error('❌ Backfill échoué:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });