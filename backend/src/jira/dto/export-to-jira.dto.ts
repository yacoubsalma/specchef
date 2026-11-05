import { IsOptional, IsString } from 'class-validator';

export class ExportToJiraDto {
  /**
   * Clé du projet Jira cible (ex: 'PROJ'), choisie par l'utilisateur dans le dropdown.
   * Optionnel une fois que l'exigence est déjà rattachée à une hiérarchie Jira
   * (Epic + Story) : dans ce cas le backend réutilise le projet déjà lié.
   */
  @IsOptional()
  @IsString()
  projectKey?: string;

  /**
   * Identifiant du type de ticket (Story/Task) choisi par l'utilisateur pour
   * représenter l'EXIGENCE — utilisé uniquement lors de la toute première
   * création de la hiérarchie pour cette exigence. Optionnel : si absent, le
   * backend choisit automatiquement le meilleur candidat.
   */
  @IsOptional()
  @IsString()
  issueTypeId?: string;

  /**
   * Clé de l'Epic Jira auquel rattacher la Story de l'exigence (ex: 'JS-1'),
   * choisie par l'utilisateur avant le type de ticket. Optionnel : certains
   * projets Jira n'utilisent pas d'Epic, ou l'utilisateur peut ne pas en lier.
   * Ignoré si l'exigence est déjà rattachée à une hiérarchie existante.
   */
  @IsOptional()
  @IsString()
  epicKey?: string;

  /**
   * Nom (résumé) personnalisé pour la Story représentant l'exigence, choisi par
   * l'utilisateur. Si absent, le backend utilise le nom généré automatiquement
   * ([req_id] description). Ignoré si la Story existe déjà pour cette exigence.
   */
  @IsOptional()
  @IsString()
  storySummary?: string;
}