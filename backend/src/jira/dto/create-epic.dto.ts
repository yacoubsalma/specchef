import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEpicDto {
  /** Nom (résumé) du nouvel Epic à créer dans le projet Jira choisi. */
  @IsString()
  @IsNotEmpty({ message: "Le nom de l'epic est requis" })
  summary: string;
}