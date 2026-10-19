<script setup lang="ts">
import { Button, GlassContainer, Stack, Surface, Text } from '@glassui/vue'
const variants = ['glass', 'glassProminent', 'filled', 'tinted', 'plain'] as const
</script>
<template>
  <Surface layer="screen" center :width="1248" :height="868" background="none">
    <Stack id="perf" :gap="12" :style="{ padding: 16 }">
      <Text value="100 buttons · 20 fused toolbars" :size="24" :weight="700" :style="{ height: 32 }" />
      <Stack :gap="8">
        <Stack v-for="row in 10" :key="row" direction="horizontal" :gap="10">
          <Button v-for="col in 10" :id="`perf-button-${(row - 1) * 10 + col - 1}`" :key="col" :variant="variants[Math.floor(((row - 1) * 10 + col - 1) / 20)]" size="small" :label="`Button ${(row - 1) * 10 + col}`" :style="{ width: 112 }" />
        </Stack>
      </Stack>
      <Stack :gap="12">
        <Stack v-for="row in 4" :key="row" direction="horizontal" :gap="56">
          <GlassContainer v-for="col in 5" :id="`perf-toolbar-${(row - 1) * 5 + col - 1}`" :key="col" :spacing="16" :gap="8">
            <Button v-for="icon in ['plus', 'search', 'gear'] as const" :key="icon" size="small" shape="circle" :leading-icon="icon" />
          </GlassContainer>
        </Stack>
      </Stack>
    </Stack>
  </Surface>
</template>
