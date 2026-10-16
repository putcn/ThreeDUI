<script setup lang="ts">
// The bin info panel's content (spatial spec §4 step 3, §11.4): what a hovered bin holds, on the glass panel that
// floats in front of the twin (Spatial.vue's world <Surface>). On mount it flies its Surface in: from a little behind
// its place (toward the twin), faded out and slightly small, to its place.
import { computed, onMounted } from 'vue'
import { Box, Stack, Text, useMotion, useSurfaceRef } from '@glassui/vue'
import { grouped, type Bin } from './data'
import { binLevel } from './warehouse'

const props = defineProps<{ bin: Bin }>()
const level = computed(() => binLevel(props.bin.occupancy))
const percent = computed(() => Math.round(props.bin.occupancy * 100))

/** World units the panel starts behind its place, toward the twin. */
const FROM = 0.3
const surface = useSurfaceRef(), frozen = useMotion() === 'frozen'
onMounted(() => {
  const s = surface.value
  if (!s) return
  const { x, y, z } = s.position, a = s.rotation.y
  s.position.set(x - FROM * Math.sin(a), y, z - FROM * Math.cos(a))
  s.opacity = 0; s.scale.setScalar(0.94)
  void s.animateTo({ position: [x, y, z], scale: 1, opacity: 1 }, { spring: { response: 0.4, dampingFraction: 0.9 }, immediate: frozen })
})
</script>

<template>
  <Stack :gap="6" :style="{ paddingX: 22, paddingY: 18, flexGrow: 1 }">
    <Stack direction="horizontal" justify="between" align="center">
      <Text value="库位" :size="13" color="secondaryLabel" />
      <Stack direction="horizontal" align="center" :gap="5" :style="{ paddingX: 9, height: 22, radius: 'capsule', bg: `${level.color}38` }">
        <Box :style="{ width: 7, height: 7, radius: 3.5, bg: level.color }" />
        <Text :value="level.label" :size="12" :weight="600" />
      </Stack>
    </Stack>
    <Text :value="bin.id" :size="28" :weight="700" :style="{ font: 'Menlo' }" :wrap="false" />
    <Text :value="`${bin.sku} · ${bin.name}`" :size="14" color="secondaryLabel" :max-lines="1" />
    <Stack direction="horizontal" justify="between" align="center" :style="{ marginTop: 2 }">
      <Text :value="[{ text: grouped(bin.qty), weight: 700 }, { text: ` / ${grouped(bin.cap)} 件`, color: 'secondaryLabel' }]" :size="15" :wrap="false" />
      <Text :value="`占用率 ${percent}%`" :size="13" color="secondaryLabel" :wrap="false" />
    </Stack>
    <Box :style="{ height: 8, radius: 4, bg: '#1c1c2214' }">
      <Box :style="{ width: `${percent}%`, height: 8, radius: 4, bg: level.color }" />
    </Box>
  </Stack>
</template>
