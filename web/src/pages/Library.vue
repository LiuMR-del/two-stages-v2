<script setup lang="ts">
import { computed } from 'vue'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import CategoryList from '../components/CategoryList.vue'
import CategoryEditor from '../components/CategoryEditor.vue'
import GlobalPrompts from '../components/GlobalPrompts.vue'

const lib = useLibrary()
const ui = useUi()
const showCategory = computed(() => ui.libSel !== '__global' && !!lib.category(ui.libSel))
</script>

<template>
  <section class="page">
    <div v-if="!lib.library" class="box none">正在读取模版库…</div>
    <div v-else class="lib">
      <CategoryList />
      <CategoryEditor v-if="showCategory" />
      <GlobalPrompts v-else />
    </div>
  </section>
</template>
