import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CoverageService } from '../coverage/coverage.service';

// ─── Includes réutilisés ──────────────────────────────────────────────────────
const FULL_PROJECT_INCLUDE = {
  modules: { include: { requirements: { include: { test_cases: true } } } },
  owner: { select: { id: true, name: true, email: true, role: true } },
  assignedUsers: { select: { id: true, name: true, email: true, role: true } },
} as const;

function scopeWhere(userId: string, isAdmin: boolean) {
  return isAdmin ? {} : { OR: [{ owner_id: userId }, { assignedUserIds: { has: userId } }] };
}

// Le sélecteur de période du dashboard n'autorise que ces 3 valeurs — tout le
// reste (absent, NaN, hors bornes) retombe sur 14j.
const ALLOWED_PERIODS = [7, 14, 30];
export function parseDashboardDays(raw?: string): number {
  const n = Number(raw);
  return ALLOWED_PERIODS.includes(n) ? n : 14;
}

// Filtre "un seul projet" optionnel, déclenché par le sélecteur de projet
// global du dashboard — se combine avec scopeWhere (droits d'accès) sans les
// court-circuiter : un projet hors périmètre reste invisible même si son id
// est passé en paramètre.
function withProject(where: Record<string, any>, projectId?: string) {
  return projectId ? { ...where, id: projectId } : where;
}

function countModulesAndRequirements(project: any) {
  const modules = project.modules ?? [];
  const requirements = modules.flatMap((m: any) => m.requirements ?? []);
  const testCases = requirements.flatMap((r: any) => r.test_cases ?? []);
  return { modulesCount: modules.length, requirementsCount: requirements.length, testCasesCount: testCases.length };
}

// La priorité est un champ texte libre côté Requirement (pas un enum Prisma),
// donc on peut se retrouver avec "high"/"Haute"/"HIGH" pour la même chose
// selon d'où vient la donnée (extraction LLM vs édition manuelle) — on
// normalise vers un libellé FR fixe pour que le donut "Par priorité" du
// dashboard BA reste lisible.
function normalizePriorityLabel(raw: string): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (['critical', 'critique'].includes(v)) return 'Critique';
  if (['high', 'haute', 'élevée', 'elevee'].includes(v)) return 'Haute';
  if (['medium', 'moyenne', 'normale', 'normal'].includes(v)) return 'Moyenne';
  if (['low', 'basse', 'faible'].includes(v)) return 'Basse';
  if (!v) return 'Non définie';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ── Séries journalières + détail par projet (pour le survol des charts
// "marqués à réviser" — on veut voir quels projets sont concernés) ──────────
function buildDailyReviewBreakdown(items: { flaggedAt: any; projectName: string }[], days = 14) {
  const dayMs = 86400000;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const windowStart = startOfToday - (days - 1) * dayMs;

  const buckets: { label: string; count: number; projects: Map<string, number> }[] = [];
  for (let i = 0; i < days; i++) {
    buckets.push({
      label: new Date(windowStart + i * dayMs).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
      count: 0,
      projects: new Map(),
    });
  }

  for (const it of items) {
    const t = it.flaggedAt ? new Date(it.flaggedAt).getTime() : NaN;
    // Pas de date connue (champ pas encore renseigné en base pour les entrées
    // anciennes) : on les compte quand même, rattachées à aujourd'hui, plutôt
    // que de les faire disparaître silencieusement du graphe (le total affiché
    // ailleurs inclut ces éléments, le graphe doit rester cohérent avec lui).
    const idx = Number.isNaN(t) ? days - 1 : Math.floor((t - windowStart) / dayMs);
    if (idx < 0) { buckets[0].count++; buckets[0].projects.set(it.projectName, (buckets[0].projects.get(it.projectName) ?? 0) + 1); continue; }
    if (idx >= days) { buckets[days - 1].count++; buckets[days - 1].projects.set(it.projectName, (buckets[days - 1].projects.get(it.projectName) ?? 0) + 1); continue; }
    buckets[idx].count++;
    buckets[idx].projects.set(it.projectName, (buckets[idx].projects.get(it.projectName) ?? 0) + 1);
  }

  return buckets.map((b) => ({
    label: b.label,
    count: b.count,
    projects: Array.from(b.projects.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  }));
}

// ── Séries journalières (pour sparklines / courbes de tendance du dashboard) ──
// Regroupe une liste de dates par jour sur une fenêtre glissante de `days` jours.
function buildDailySeries(dates: (Date | string | null | undefined)[], days = 14) {
  const dayMs = 86400000;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const windowStart = startOfToday - (days - 1) * dayMs;

  const labels: string[] = [];
  const counts: number[] = new Array(days).fill(0);
  for (let i = 0; i < days; i++) {
    labels.push(new Date(windowStart + i * dayMs).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
  }

  for (const raw of dates) {
    if (!raw) continue;
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) continue;
    const idx = Math.floor((t - windowStart) / dayMs);
    if (idx >= 0 && idx < days) counts[idx]++;
  }

  return { labels, counts };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverageService: CoverageService,
  ) {}

  // ── Couverture SRS ↔ Exigences — résumé compact pour le dashboard Admin ────
  // Réutilise CoverageService.computeCoverage (déjà mis en cache 30s côté service).
  // Bornée à `limit` projets (les plus récemment mis à jour parmi ceux qui ont
  // des exigences) pour ne pas surcharger le dashboard — chaque appel fait une
  // comparaison vectorielle chunks × exigences. Ne renvoie QUE le résumé global
  // + les 3 pires : c'est un signal d'alerte plateforme, pas un audit détaillé
  // projet par projet (ça, c'est l'onglet 🎯 Couverture SRS de chaque projet).
  private async getSrsCoverageSummary(
    candidates: { id: string; name: string; updatedAt: Date; requirementsCount: number }[],
    limit = 8,
  ) {
    const eligible = candidates
      .filter((p) => p.requirementsCount > 0)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);

    const projectsCoverage: { projectId: string; projectName: string; coveragePercentage: number }[] = [];

    for (const p of eligible) {
      try {
        const cov = await this.coverageService.computeCoverage(p.id);
        if (cov.hasSrs && cov.hasRequirements) {
          projectsCoverage.push({ projectId: p.id, projectName: p.name, coveragePercentage: cov.coveragePercentage });
        }
      } catch {
        // Un projet en erreur (embeddings indisponibles, etc.) ne doit pas casser le dashboard.
      }
    }

    const avgPercentage = projectsCoverage.length > 0
      ? Math.round((projectsCoverage.reduce((sum, r) => sum + r.coveragePercentage, 0) / projectsCoverage.length) * 10) / 10
      : 0;
    const worst = [...projectsCoverage].sort((a, b) => a.coveragePercentage - b.coveragePercentage).slice(0, 3);

    return { avgPercentage, evaluatedCount: projectsCoverage.length, worst };
  }


  // ── ADMIN ────────────────────────────────────────────────────────────────
  // Vue globale de la plateforme + focus sur les projets créés par cet admin.
  async getAdminDashboard(userId: string, days = 14, projectId?: string) {
    const [totalProjects, allProjects, usersByRoleRaw, projectsThisMonthCount] = await Promise.all([
      this.prisma.project.count(),
      this.prisma.project.findMany({
        where: withProject({}, projectId),
        orderBy: { created_at: 'desc' },
        include: FULL_PROJECT_INCLUDE,
      }),
      this.prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
      this.prisma.project.count({
        where: { created_at: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
    ]);

    const byStatus = { processing: 0, done: 0, error: 0 } as Record<string, number>;
    for (const p of allProjects) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

    const usersByRole: Record<string, number> = { ADMIN: 0, QA: 0, BA: 0, PO: 0 };
    for (const r of usersByRoleRaw) usersByRole[r.role] = r._count.role;

    // ── Séries pour les widgets style Langfuse (sparklines + courbe de tendance) ──
    const byDay = buildDailySeries(allProjects.map((p: any) => p.created_at), days);
    const series = {
      labels: byDay.labels,
      created: byDay.counts,
      done: buildDailySeries(allProjects.filter((p: any) => p.status === 'done').map((p: any) => p.created_at), days).counts,
      processing: buildDailySeries(allProjects.filter((p: any) => p.status === 'processing').map((p: any) => p.created_at), days).counts,
    };

    // Tous les projets de la plateforme, tous propriétaires confondus (pas
    // seulement ceux de l'admin connecté) — trié par création, le plus récent en tête.
    const recentProjects = allProjects
      .slice(0, 10)
      .map((p: any) => {
        const { modulesCount, requirementsCount } = countModulesAndRequirements(p);
        return {
          id: p.id,
          name: p.name,
          status: p.status,
          createdAt: p.created_at,
          owner: p.owner ? { id: p.owner.id, name: p.owner.name } : null,
          assignedUsers: (p.assignedUsers ?? []).map((u: any) => ({ id: u.id, name: u.name, role: u.role })),
          modulesCount,
          requirementsCount,
        };
      });

    // ── Nouveaux projets par jour — même format que les charts "à réviser"
    // du BA/QA (barres + détail par projet au survol), pour repérer les pics d'activité.
    const projectsByDay = buildDailyReviewBreakdown(
      allProjects.map((p: any) => ({ flaggedAt: p.created_at, projectName: p.name })),
      days,
    );

    // ── Alertes plateforme ──────────────────────────────────────────────────
    // Extractions "processing" bloquées depuis > 2h : très probablement plantées
    // (un pipeline sain finit en quelques minutes), pas juste "encore en cours".
    const stuckThreshold = new Date(Date.now() - 2 * 3600000);
    const stuckProjects = allProjects
      .filter((p: any) => p.status === 'processing' && new Date(p.updated_at).getTime() < stuckThreshold.getTime())
      .sort((a: any, b: any) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
      .slice(0, 8)
      .map((p: any) => ({ id: p.id, name: p.name, updatedAt: p.updated_at }));

    const srsCoverage = await this.getSrsCoverageSummary(
      allProjects.map((p: any) => ({
        id: p.id, name: p.name, updatedAt: p.updated_at,
        requirementsCount: countModulesAndRequirements(p).requirementsCount,
      })),
    );

    return {
      kpis: {
        totalProjects,
        projectsThisMonth: projectsThisMonthCount,
        byStatus,
        totalUsers: Object.values(usersByRole).reduce((a, b) => a + b, 0),
        usersByRole,
      },
      series,
      recentProjects,
      projectsByDay,
      srsCoverage,
      alerts: { stuckProjects, count: stuckProjects.length },
    };
  }

  // ── BA (Business Analyst) ───────────────────────────────────────────────
  // Focus sur les projets où le BA crée/édite le SRS, + export Jira.
  async getBaDashboard(userId: string, isAdmin: boolean, days = 14, projectId?: string) {
    const projects = await this.prisma.project.findMany({
      where: withProject(scopeWhere(userId, isAdmin), projectId),
      orderBy: { updated_at: 'desc' },
      include: FULL_PROJECT_INCLUDE,
    });

    let totalModules = 0;
    let totalRequirements = 0;
    let requirementsEditedRecently = 0;
    let jiraExportsCount = 0;

    const recentEdits: any[] = [];
    const recentJiraExports: any[] = [];
    const projectsToProcess: any[] = [];
    const reqCreatedDates: any[] = [];
    const reqEditedDates: any[] = [];
    const priorityCounts: Record<string, number> = {};
    const reqsNeedingReview: any[] = [];
    // Répartition par projet — modules/exigences/exports Jira/à réviser rattachés
    // chacun à leur projet plutôt que noyés dans un total global de la plateforme.
    const byProjectMap = new Map<string, { projectId: string; projectName: string; modulesCount: number; requirementsCount: number; jiraExportsCount: number; reqsNeedingReviewCount: number; updatedAt: Date }>();
    // Dernière activité (création/édition d'exigence) par projet — sert à
    // détecter un SRS ré-uploadé/réindexé après la dernière extraction.
    const lastReqActivityByProject = new Map<string, number>();
    const bumpLastActivity = (id: string, at: any) => {
      const t = at ? new Date(at).getTime() : 0;
      if (t > (lastReqActivityByProject.get(id) ?? 0)) lastReqActivityByProject.set(id, t);
    };

    for (const p of projects) {
      const { modulesCount, requirementsCount } = countModulesAndRequirements(p);
      totalModules += modulesCount;
      totalRequirements += requirementsCount;
      byProjectMap.set(p.id, {
        projectId: p.id, projectName: p.name, modulesCount, requirementsCount,
        jiraExportsCount: 0, reqsNeedingReviewCount: 0, updatedAt: p.updated_at,
      });

      if (p.status === 'done') {
        projectsToProcess.push({
          id: p.id, name: p.name, status: p.status,
          modulesCount, requirementsCount, updatedAt: p.updated_at,
        });
      }

      for (const mod of p.modules ?? []) {
        for (const req of mod.requirements ?? []) {
          reqCreatedDates.push(req.created_at);
          bumpLastActivity(p.id, req.created_at);
          const priorityLabel = normalizePriorityLabel(req.priority);
          priorityCounts[priorityLabel] = (priorityCounts[priorityLabel] ?? 0) + 1;
          if ((req as any).needs_review) {
            reqsNeedingReview.push({
              requirementId: req.id, reqId: req.req_id, description: req.description,
              reason: (req as any).needs_review_reason ?? null,
              moduleId: mod.id, moduleName: mod.name,
              projectId: p.id, projectName: p.name,
              flaggedAt: (req as any).needs_review_at,
            });
            byProjectMap.get(p.id)!.reqsNeedingReviewCount++;
          }
          if (req.manually_edited) {
            requirementsEditedRecently++;
            reqEditedDates.push(req.updated_at);
            bumpLastActivity(p.id, req.updated_at);
            recentEdits.push({
              requirementId: req.id, reqId: req.req_id, description: req.description,
              moduleId: mod.id, moduleName: mod.name,
              projectId: p.id, projectName: p.name,
              updatedAt: req.updated_at,
            });
          }
          for (const tc of req.test_cases ?? []) {
            if (tc.jira_exported_at) {
              jiraExportsCount++;
              byProjectMap.get(p.id)!.jiraExportsCount++;
              recentJiraExports.push({
                testCaseId: tc.id, testId: tc.test_id, title: tc.title,
                jiraIssueKey: tc.jira_issue_key, jiraIssueUrl: tc.jira_issue_url,
                jiraExportedAt: tc.jira_exported_at, projectName: p.name,
              });
            }
          }
        }
      }
    }

    recentEdits.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    recentJiraExports.sort((a, b) => new Date(b.jiraExportedAt).getTime() - new Date(a.jiraExportedAt).getTime());
    reqsNeedingReview.sort((a, b) => new Date(b.flaggedAt ?? 0).getTime() - new Date(a.flaggedAt ?? 0).getTime());

    // ── Fraîcheur du SRS ─────────────────────────────────────────────────────
    // Le document le plus récent par projet (upload/réindexation) comparé à la
    // dernière activité connue sur ses exigences : si le SRS a été touché APRÈS,
    // les exigences en base ne reflètent probablement plus le document actuel.
    const srsDocs = await this.prisma.srsDocument.findMany({
      where: { project_id: { in: projects.map((p) => p.id) } },
      orderBy: { updated_at: 'desc' },
      select: { project_id: true, updated_at: true, filename: true },
    });
    const latestSrsDocByProject = new Map<string, { updatedAt: Date; filename: string }>();
    for (const d of srsDocs) {
      if (!latestSrsDocByProject.has(d.project_id)) latestSrsDocByProject.set(d.project_id, { updatedAt: d.updated_at, filename: d.filename });
    }

    const byProject = Array.from(byProjectMap.values())
      .map((p) => {
        const srsDoc = latestSrsDocByProject.get(p.projectId);
        const lastActivity = lastReqActivityByProject.get(p.projectId) ?? 0;
        const srsOutdated = !!srsDoc && (lastActivity === 0 || new Date(srsDoc.updatedAt).getTime() > lastActivity);
        return {
          ...p,
          srsUpdatedAt: srsDoc?.updatedAt ?? null,
          srsOutdated,
        };
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const baByDay = buildDailySeries(reqCreatedDates, days);
    const series = {
      labels: baByDay.labels,
      requirementsAdded: baByDay.counts,
      requirementsEdited: buildDailySeries(reqEditedDates, days).counts,
      byPriority: priorityCounts,
    };
    const reqsReviewByDay = buildDailyReviewBreakdown(reqsNeedingReview, days);

    // ── Activité des autres BA sur ces mêmes projets ────────────────────────
    // Un projet peut être partagé entre plusieurs BA (assignedUsers) : utile
    // de voir ce que les collègues y ont fait récemment, pas seulement soi-même.
    const otherBaActivity = await this.getOtherUsersActivity(projects.map((p) => p.id), userId, isAdmin);

    return {
      kpis: {
        activeProjects: projects.length,
        totalModules,
        totalRequirements,
        requirementsEditedRecently,
        requirementsNeedingReview: reqsNeedingReview.length,
        jiraExportsCount,
      },
      series,
      byProject,
      projectsToProcess: projectsToProcess.slice(0, 10),
      recentEdits: recentEdits.slice(0, 5),
      reqsNeedingReview,
      reqsReviewByDay,
      recentJiraExports: recentJiraExports.slice(0, 5),
      otherBaActivity,
    };
  }

  // ── Activité récente d'AUTRES utilisateurs sur des projets partagés ────────
  // S'appuie sur EntityVersion (historique déjà tracé pour l'undo/la timeline)
  // qui porte changed_by_id/changed_by_name — on exclut l'utilisateur courant
  // pour ne montrer que ce que les collègues ont fait.
  private async getOtherUsersActivity(projectIds: string[], userId: string, isAdmin: boolean) {
    if (projectIds.length === 0) return [];
    const versions = await this.prisma.entityVersion.findMany({
      where: {
        project_id: { in: projectIds },
        entity_type: { in: ['requirement', 'requirement_module'] },
        ...(isAdmin ? {} : { changed_by_id: { not: userId } }),
      },
      orderBy: { created_at: 'desc' },
      take: 8,
    });
    if (versions.length === 0) return [];

    const projects = await this.prisma.project.findMany({
      where: { id: { in: [...new Set(versions.map((v) => v.project_id))] } },
      select: { id: true, name: true },
    });
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

    return versions.map((v) => ({
      id: v.id,
      projectId: v.project_id,
      projectName: projectNameById.get(v.project_id) ?? '—',
      entityType: v.entity_type,
      changeType: v.change_type,
      changeSummary: v.change_summary,
      changedByName: v.changed_by_name ?? 'Un autre utilisateur',
      createdAt: v.created_at,
    }));
  }

  // ── PO — vue globale des campagnes ──────────────────────────────────────
  // Alimente le widget "Campagnes" du dashboard (BaDashboard, affiché
  // seulement pour le rôle PO) + la page globale /campaigns : un projet par
  // ligne avec son statut de campagne et son avancement (part de TC avec un
  // verdict passed/failed sur le total), plus les KPIs agrégés.
  async getPoCampaignsOverview(userId: string, isAdmin: boolean, days = 14, projectId?: string) {
    const projects = await this.prisma.project.findMany({
      where: withProject(scopeWhere(userId, isAdmin), projectId),
      orderBy: { updated_at: 'desc' },
      select: {
        id: true, name: true,
        campaign_status: true, campaign_launched_at: true, campaign_closed_at: true,
        modules: { include: { requirements: { include: { test_cases: { select: { execution_status: true, executed_at: true } } } } } },
        // Dernière activité d'exécution — pour repérer une campagne active
        // sans progression récente (voir isStagnant côté frontend).
        workflows: { where: { is_validated: true }, select: { last_run_at: true } },
      },
    });

    const projectIds = projects.map((p) => p.id);
    const pendingByProject = await this.prisma.campaignChange.groupBy({
      by: ['project_id'],
      where: { project_id: { in: projectIds }, status: 'pending' },
      _count: { _all: true },
    });
    const pendingMap = new Map(pendingByProject.map((g) => [g.project_id, g._count._all]));

    const rows = projects.map((p) => {
      const testCases = (p.modules ?? []).flatMap((m) => m.requirements ?? []).flatMap((r) => r.test_cases ?? []);
      const total = testCases.length;
      const passed = testCases.filter((tc) => tc.execution_status === 'passed').length;
      const failed = testCases.filter((tc) => tc.execution_status === 'failed').length;
      const progressPct = total > 0 ? Math.round(((passed + failed) / total) * 100) : 0;
      // Max des dates d'activité (exécution de TC ou de workflow) — reflète
      // uniquement le cycle EN COURS, puisque launchCampaign remet executed_at
      // et last_run_at à null à chaque nouveau lancement.
      const activityDates = [
        ...testCases.map((tc) => tc.executed_at),
        ...(p.workflows ?? []).map((w) => w.last_run_at),
      ].filter((d): d is Date => d !== null);
      const lastActivityAt = activityDates.length > 0
        ? new Date(Math.max(...activityDates.map((d) => d.getTime())))
        : null;
      return {
        projectId: p.id, projectName: p.name,
        campaignStatus: p.campaign_status,
        launchedAt: p.campaign_launched_at, closedAt: p.campaign_closed_at,
        testCases: { total, passed, failed, notTested: total - passed - failed },
        progressPct,
        pendingChangesCount: pendingMap.get(p.id) ?? 0,
        lastActivityAt,
      };
    });

    const launched = rows.filter((r) => r.campaignStatus === 'launched');
    const avgProgress = launched.length > 0 ? Math.round(launched.reduce((s, r) => s + r.progressPct, 0) / launched.length) : 0;

    rows.sort((a, b) => {
      if (a.campaignStatus === 'launched' && b.campaignStatus !== 'launched') return -1;
      if (b.campaignStatus === 'launched' && a.campaignStatus !== 'launched') return 1;
      return new Date(b.launchedAt ?? 0).getTime() - new Date(a.launchedAt ?? 0).getTime();
    });

    return {
      kpis: {
        activeCampaigns: launched.length,
        totalProjects: rows.length,
        avgProgress,
        totalPendingChanges: rows.reduce((s, r) => s + r.pendingChangesCount, 0),
      },
      projects: rows,
    };
  }

  // ── PO — dashboard dédié ────────────────────────────────────────────────
  // Contrairement au BA (édition des exigences), le PO pilote l'avancement
  // produit : campagnes en cours, projets prêts à lancer, traçabilité Jira.
  // Reprend les KPIs de getPoCampaignsOverview plutôt que de les recalculer.
  async getPoDashboard(userId: string, isAdmin: boolean, days = 14, projectId?: string) {
    const [campaigns, projects] = await Promise.all([
      this.getPoCampaignsOverview(userId, isAdmin, days, projectId),
      this.prisma.project.findMany({
        where: withProject(scopeWhere(userId, isAdmin), projectId),
        orderBy: { updated_at: 'desc' },
        include: FULL_PROJECT_INCLUDE,
      }),
    ]);

    // ── Prêts à lancer ────────────────────────────────────────────────────
    // Projets encore en "draft" (jamais lancés ou campagne clôturée), avec au
    // moins un cas de test, et STRICTEMENT 0 cas de test en attente ou rejeté
    // côté QA (review_status) — donc 100% validés, pas d'approximation par taux.
    const readiness = projects
      .filter((p: any) => p.campaign_status === 'draft')
      .map((p: any) => {
        const { modulesCount, requirementsCount, testCasesCount } = countModulesAndRequirements(p);
        const testCases = (p.modules ?? []).flatMap((m: any) => m.requirements ?? []).flatMap((r: any) => r.test_cases ?? []);
        const pendingCount = testCases.filter((tc: any) => tc.review_status === 'pending').length;
        const rejectedCount = testCases.filter((tc: any) => tc.review_status === 'rejected').length;
        const validatedTc = testCases.filter((tc: any) => tc.review_status === 'validated').length;
        return {
          id: p.id, name: p.name, updatedAt: p.updated_at,
          modulesCount, requirementsCount, testCasesCount, validatedTc,
          pendingCount, rejectedCount,
        };
      })
      .filter((p: any) => p.testCasesCount > 0 && p.pendingCount === 0 && p.rejectedCount === 0)
      .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);

    const workflowRuns = await this.getQaWorkflowRuns(projects.map((p: any) => p.id), days);
    const launchesByDay = await this.getCampaignLaunchHistory(projects.map((p: any) => p.id), days);

    return {
      kpis: campaigns.kpis,
      campaignProjects: campaigns.projects,
      launchesByDay,
      readiness,
      workflowRuns,
    };
  }

  // ── Historique des lancements de campagnes — calendrier type "GitHub" ──────
  // S'appuie sur CampaignRun (un enregistrement par cycle lancement→clôture),
  // PAS sur Project.campaign_launched_at qui n'est qu'un instantané du dernier
  // cycle et perd l'historique dès qu'un projet est relancé après clôture.
  // Une entrée par jour de la période (même à 0), avec la date ISO exacte pour
  // que le front puisse placer chaque case dans sa colonne/ligne du calendrier.
  private async getCampaignLaunchHistory(projectIds: string[], days: number) {
    const dayMs = 86400000;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const windowStart = startOfToday - (days - 1) * dayMs;

    const cells: { date: string; count: number; projects: { name: string; count: number }[] }[] = [];
    const projectsPerDay: Map<string, number>[] = [];
    for (let i = 0; i < days; i++) {
      cells.push({ date: new Date(windowStart + i * dayMs).toISOString().slice(0, 10), count: 0, projects: [] });
      projectsPerDay.push(new Map());
    }

    if (projectIds.length > 0) {
      const runs = await this.prisma.campaignRun.findMany({
        where: { project_id: { in: projectIds }, launched_at: { gte: new Date(windowStart) } },
        select: { launched_at: true, project: { select: { name: true } } },
      });
      for (const r of runs) {
        const idx = Math.floor((new Date(r.launched_at).getTime() - windowStart) / dayMs);
        if (idx < 0 || idx >= days) continue;
        cells[idx].count++;
        const name = r.project?.name ?? '—';
        projectsPerDay[idx].set(name, (projectsPerDay[idx].get(name) ?? 0) + 1);
      }
      cells.forEach((c, i) => {
        c.projects = Array.from(projectsPerDay[i].entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      });
    }

    return cells;
  }

  // ── QA (Quality Assurance) ──────────────────────────────────────────────
  // Focus sur les test cases : génération, validation, rejet, export Jira.
  async getQaDashboard(userId: string, isAdmin: boolean, days = 14, projectId?: string) {
    const projects = await this.prisma.project.findMany({
      where: withProject(scopeWhere(userId, isAdmin), projectId),
      orderBy: { updated_at: 'desc' },
      include: FULL_PROJECT_INCLUDE,
    });

    let totalTestCases = 0;
    let validated = 0;
    let rejected = 0;
    let pending = 0;
    let jiraExportsCount = 0;

    const reviewQueue: any[] = [];
    const recentJiraExports: any[] = [];
    const byProject: any[] = [];
    const tcCreatedDates: any[] = [];
    const tcValidatedDates: any[] = [];
    const tcRejectedDates: any[] = [];
    const tcsNeedingReview: any[] = [];
    for (const p of projects) {
      let pTotal = 0, pValidated = 0, pRejected = 0, pPending = 0;

      for (const mod of p.modules ?? []) {
        for (const req of mod.requirements ?? []) {
          for (const tc of req.test_cases ?? []) {
            totalTestCases++;
            pTotal++;
            const status = (tc as any).review_status ?? (tc.validated ? 'validated' : 'pending');
            tcCreatedDates.push(tc.created_at);

            if ((tc as any).needs_review) {
              tcsNeedingReview.push({
                id: tc.id, testId: tc.test_id, title: tc.title,
                reason: (tc as any).needs_review_reason ?? null,
                requirementId: req.id, reqId: req.req_id,
                moduleId: mod.id, moduleName: mod.name,
                projectId: p.id, projectName: p.name,
                flaggedAt: (tc as any).needs_review_at,
              });
            }

            if (status === 'validated') { validated++; pValidated++; tcValidatedDates.push(tc.validated_at ?? tc.created_at); }
            else if (status === 'rejected') { rejected++; pRejected++; tcRejectedDates.push((tc as any).rejected_at ?? tc.updated_at ?? tc.created_at); }
            else { pending++; pPending++; }

            if (status === 'pending') {
              reviewQueue.push({
                id: tc.id, testId: tc.test_id, title: tc.title,
                type: tc.type, priority: tc.priority,
                requirementId: req.id, reqId: req.req_id,
                projectId: p.id, projectName: p.name,
                createdAt: tc.created_at,
              });
            }

            if (tc.jira_exported_at) {
              jiraExportsCount++;
              recentJiraExports.push({
                testCaseId: tc.id, testId: tc.test_id, title: tc.title,
                jiraIssueKey: tc.jira_issue_key, jiraIssueUrl: tc.jira_issue_url,
                jiraExportedAt: tc.jira_exported_at, projectName: p.name,
              });
            }
          }

          // ── TC générés mais pas encore validés (autosave, pas encore en base
          // dans TestCase — voir Requirement.pending_test_cases) : ils sont par
          // définition en attente, donc comptés dans la file de validation même
          // si aucune ligne TestCase n'existe encore pour eux. Pas de created_at
          // fiable (juste un instantané JSON) → createdAt: null.
          const pendingSnapshot = Array.isArray((req as any).pending_test_cases) ? (req as any).pending_test_cases : [];
          pendingSnapshot.forEach((tc: any, idx: number) => {
            totalTestCases++;
            pTotal++;
            pending++;
            pPending++;
            reviewQueue.push({
              id: `pending-${req.id}-${idx}`,
              testId: tc.test_id ?? tc.testId ?? '',
              title: tc.title ?? '',
              type: tc.type ?? tc.test_type ?? null,
              priority: tc.priority ?? null,
              requirementId: req.id, reqId: req.req_id,
              projectId: p.id, projectName: p.name,
              createdAt: null,
              draft: true,
            });
          });
        }
      }

      // "Rejetés (total)", "Tendance des test cases
      // (14 derniers jours)" et "Par statut" n'affichaient QUE les TC déjà
      // persistés puis rejetés via le workflow de revue — un TC "en attente"
      // rejeté (jamais persisté, voir Requirement.pending_test_cases) n'y
      // apparaissait jamais, alors qu'il est bien retiré de la file de
      // validation. On l'intègre ici au même titre qu'un rejet "classique",
      // en piochant les horodatages accumulés dans
      // Project.rejected_pending_dates (voir rejectPendingTestCase) — sans
      // ça, `rejected`/`tcRejectedDates` restaient figés pour ce type de
      // rejet quel que soit le nombre de fois où un QA rejette un TC en
      // attente.
      const rejectedPendingDates = ((p as any).rejected_pending_dates ?? []) as Date[];
      for (const d of rejectedPendingDates) {
        totalTestCases++; pTotal++;
        rejected++; pRejected++;
        tcRejectedDates.push(d);
      }

      if (pTotal > 0) {
        byProject.push({
          projectId: p.id, projectName: p.name,
          total: pTotal, validated: pValidated, rejected: pRejected, pending: pPending,
        });
      }
    }

    // Les TC "draft" (createdAt null) n'ont pas de date fiable — on les place
    // en fin de liste plutôt que de fausser le tri avec un NaN.
    reviewQueue.sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
      return at - bt;
    });
    recentJiraExports.sort((a, b) => new Date(b.jiraExportedAt).getTime() - new Date(a.jiraExportedAt).getTime());
    tcsNeedingReview.sort((a, b) => new Date(b.flaggedAt ?? 0).getTime() - new Date(a.flaggedAt ?? 0).getTime());

    const validationRate = totalTestCases > 0 ? Math.round((validated / totalTestCases) * 1000) / 10 : 0;

    const qaByDay = buildDailySeries(tcCreatedDates, days);
    const series = {
      labels: qaByDay.labels,
      created: qaByDay.counts,
      validated: buildDailySeries(tcValidatedDates, days).counts,
      rejected: buildDailySeries(tcRejectedDates, days).counts,
    };
    const tcsReviewByDay = buildDailyReviewBreakdown(tcsNeedingReview, days);

    const workflowRuns = await this.getQaWorkflowRuns(projects.map((p) => p.id), days);

    return {
      kpis: {
        totalTestCases, validated, rejected, pending, validationRate,
        testCasesNeedingReview: tcsNeedingReview.length, jiraExportsCount,
        // Rejets de générations en attente (jamais persistées) — désormais
        // aussi intégrés dans `rejected`/`series.rejected` ci-dessus (voir
        // le commentaire dans la boucle projects) ; ce total reste affiché
        // séparément pour distinguer "rejeté avant persistance" de "rejeté
        // après revue classique".
        rejectedPendingCount: projects.reduce((s, p: any) => s + ((p.rejected_pending_dates ?? []).length), 0),
      },
      series,
      reviewQueue,
      tcsNeedingReview,
      tcsReviewByDay,
      byProject,
      recentJiraExports: recentJiraExports.slice(0, 5),
      workflowRuns,
    };
  }

  // ── Exécutions de workflows (campagnes) — widget dashboard QA ──────────────
  // Le run est indépendant de la validation des TC : il trace le passage d'un
  // workflow (graphe de test) sur les projets accessibles à ce QA.
  private async getQaWorkflowRuns(projectIds: string[], days: number) {
    if (projectIds.length === 0) {
      return { kpis: { total: 0, passed: 0, failed: 0, partial: 0, aborted: 0, running: 0 }, series: { labels: [], counts: [] }, recent: [] };
    }

    const since = new Date(Date.now() - days * 86400000);
    const [totalRuns, byStatusRaw, recentDated, recentRuns] = await Promise.all([
      this.prisma.workflowRun.count({ where: { project_id: { in: projectIds } } }),
      this.prisma.workflowRun.groupBy({ by: ['status'], where: { project_id: { in: projectIds } }, _count: { _all: true } }),
      this.prisma.workflowRun.findMany({
        where: { project_id: { in: projectIds }, started_at: { gte: since } },
        select: { started_at: true },
      }),
      this.prisma.workflowRun.findMany({
        where: { project_id: { in: projectIds } },
        orderBy: { started_at: 'desc' },
        take: 8,
        include: {
          workflow: { select: { name: true } },
          executed_by: { select: { name: true } },
        },
      }),
    ]);

    const byStatus: Record<string, number> = { running: 0, passed: 0, failed: 0, partial: 0, aborted: 0 };
    for (const r of byStatusRaw) byStatus[r.status] = r._count._all;

    const projectNameById = new Map<string, string>();
    // Les noms de projet sont résolus séparément (pas de include côté runs)
    // pour éviter de sur-charger la requête principale avec la relation Project.
    const projectsForNames = await this.prisma.project.findMany({
      where: { id: { in: recentRuns.map((r) => r.project_id) } },
      select: { id: true, name: true },
    });
    for (const p of projectsForNames) projectNameById.set(p.id, p.name);

    const runsByDay = buildDailySeries(recentDated.map((r) => r.started_at), days);

    return {
      kpis: { total: totalRuns, ...byStatus },
      series: { labels: runsByDay.labels, counts: runsByDay.counts },
      recent: recentRuns.map((r) => ({
        id: r.id,
        workflowId: r.workflow_id,
        workflowName: r.workflow?.name ?? '—',
        projectId: r.project_id,
        projectName: projectNameById.get(r.project_id) ?? '—',
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        executedByName: r.executed_by?.name ?? null,
      })),
    };
  }
}