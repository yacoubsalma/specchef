import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Vérifie que la propriété décorée a la même valeur qu'une autre propriété
 * de l'objet (ex: confirmPassword === newPassword).
 * Porté depuis Flow-Space (core/common/validators/matches-property.validator.ts).
 */
export function MatchesProperty(property: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'matchesProperty',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const [relatedPropertyName] = args.constraints;
          const relatedValue = (args.object as any)[relatedPropertyName];
          return value === relatedValue;
        },
        defaultMessage(args: ValidationArguments) {
          const [relatedPropertyName] = args.constraints;
          return `${args.property} doit correspondre à ${relatedPropertyName}`;
        },
      },
    });
  };
}
