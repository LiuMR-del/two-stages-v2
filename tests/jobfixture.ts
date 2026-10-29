import { newSteps, type Job } from '../server/src/store/jobs'

export function fakeJob(id = 'j1', order = 1): Job {
  return {
    id,
    createdAt: new Date().toISOString(),
    order,
    source: { file: 'source.png', originalName: `${id}.png`, width: 100, height: 100, sha256: 'x' },
    outputDay: '2026-10-26',
    outputFolder: '主图生成-2026-10-26-0900',
    outputBase: id,
    sku: null,
    paused: false,
    route: null,
    plan: null,
    steps: newSteps(),
    info: null,
    attention: null,
    override: null,
    qc: null,
    mainQc: null,
    face: null,
    deformed: false,
    parent: null,
  }
}
