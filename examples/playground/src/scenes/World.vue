<script setup lang="ts">
import { ref } from 'vue'
import { Box, Button, Stack, Surface, Switch, Text } from '@glassui/vue'
const ambient = ref(true), continued = ref(false)
</script>
<template>
  <Surface layer="world" :width="600" :height="360" :pt-per-unit="244" :position="[2.2, 0.15, -2.2]" :rotation="[0.3, -0.35, 0]" background="glass" :radius="32">
    <Stack id="world" :gap="0" :style="{ padding: 36, paddingTop: 30 }">
      <Text value="World layer" :size="30" :weight="700" :style="{ height: 40 }" />
      <Box :style="{ height: 6 }" />
      <Text value="Perspective · occlusion · 世界层光照" :size="18" :weight="500" color="secondaryLabel" :style="{ height: 28 }" />
      <Box :style="{ height: 31 }" />
      <Stack direction="horizontal" justify="between" align="center" :style="{ height: 62 }">
        <Text :value="continued ? 'Continued' : 'Ambient glow'" :size="20" :weight="500" />
        <Switch id="ambient" v-model:checked="ambient" />
      </Stack>
      <Box :style="{ height: 49 }" />
      <Stack direction="horizontal" :gap="24">
        <Button id="cancel" label="Cancel" size="large" :style="{ width: 252, height: 76 }" @press="continued = false" />
        <Button id="continue" label="Continue" variant="glassProminent" size="large" trailing-icon="arrow-right" :style="{ width: 252, height: 76 }" @press="continued = true" />
      </Stack>
    </Stack>
  </Surface>
</template>
