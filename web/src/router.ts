import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'work', component: () => import('./pages/Workbench.vue') },
    { path: '/library', name: 'library', component: () => import('./pages/Library.vue') },
  ],
})
