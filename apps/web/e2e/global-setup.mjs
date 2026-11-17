// Global setup : la maquette passerelle vit pour TOUTE la session e2e.
// Avant, gateway.spec la démarrait dans son worker — un autre fichier
// (ex. tools.spec) pouvait tourner après sa fermeture, gateway down.
// Ici : démarrage avant tous les tests, arrêt à la fin de la session.
import { startMockGateway } from './mock-gateway.mjs'

export default async function globalSetup() {
  const mock = await startMockGateway(9801)
  return async () => {
    await mock.close()
  }
}
