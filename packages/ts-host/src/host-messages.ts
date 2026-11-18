import { t, type LocaleDict } from '@ai37/agent-sdk'
import { currentLocale } from './als'

/**
 * Тексты, которые хост пишет пользователю сам, когда агент своего текста не дал. Язык — локаль хода
 * (`currentLocale()`): без локали в конверте и токене это русский, как было. Русский — источник истины.
 */
export const HOST_MESSAGES = {
  failed: { ru: 'Ошибка', en: 'Error', es: 'Error', de: 'Fehler', fr: 'Erreur', pt: 'Erro' },
  inputRequired: {
    ru: 'Уточните',
    en: 'Please clarify',
    es: 'Precisa tu solicitud',
    de: 'Bitte präzisieren Sie',
    fr: 'Veuillez préciser',
    pt: 'Esclareça, por favor',
  },
  toolFailed: {
    ru: 'Ошибка выполнения',
    en: 'Execution failed',
    es: 'Error de ejecución',
    de: 'Ausführung fehlgeschlagen',
    fr: 'Échec de l’exécution',
    pt: 'Falha na execução',
  },
  done: { ru: 'Готово', en: 'Done', es: 'Hecho', de: 'Fertig', fr: 'Terminé', pt: 'Concluído' },
  skillUnavailable: {
    ru: (skill: string) => `Запрошенный скилл «${skill}» недоступен у этого агента.`,
    en: (skill: string) => `The requested skill “${skill}” is not available for this agent.`,
    es: (skill: string) => `La habilidad solicitada «${skill}» no está disponible en este agente.`,
    de: (skill: string) => `Der angeforderte Skill „${skill}“ ist bei diesem Agenten nicht verfügbar.`,
    fr: (skill: string) => `La compétence demandée « ${skill} » n’est pas disponible pour cet agent.`,
    pt: (skill: string) => `A habilidade solicitada “${skill}” não está disponível neste agente.`,
  },
  skillNeedsAuth: {
    ru: 'Скилл требует авторизованного доступа, а ход пришёл без него.',
    en: 'This skill requires authorized access, but the request came without it.',
    es: 'Esta habilidad requiere acceso autorizado, pero la solicitud llegó sin él.',
    de: 'Dieser Skill erfordert einen autorisierten Zugriff, die Anfrage kam jedoch ohne ihn.',
    fr: 'Cette compétence nécessite un accès autorisé, mais la requête est arrivée sans.',
    pt: 'Esta habilidade exige acesso autorizado, mas a solicitação chegou sem ele.',
  },
} satisfies Record<string, LocaleDict<string> | LocaleDict<(skill: string) => string>>

type HostMessageKey = keyof typeof HOST_MESSAGES

/** Текст хоста на языке хода. */
export const hostMessage = <K extends HostMessageKey>(key: K): (typeof HOST_MESSAGES)[K]['en'] =>
  t(currentLocale(), HOST_MESSAGES[key] as LocaleDict<(typeof HOST_MESSAGES)[K]['en']>)
