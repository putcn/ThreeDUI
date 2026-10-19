<script setup lang="ts">
import { computed, ref } from 'vue'
import { Box, Button, Checkbox, Icon, Input, Stack, Switch, Text, useScheme } from '@glassui/vue'

const props = defineProps<{ loading?: boolean; errors?: { email?: string; password?: string } }>()
const emit = defineEmits<{ submit: [value: { name: string; email: string; password: string; terms: boolean; remember: boolean }] }>()
const scheme = useScheme()
const body = computed(() => scheme.value === 'dark' ? 'label' : '#3a3a48')
const name = ref(''), email = ref(''), password = ref(''), terms = ref(true), remember = ref(true)
const submit = () => { if (!props.loading) emit('submit', { name: name.value, email: email.value, password: password.value, terms: terms.value, remember: remember.value }) }
const errorStyle = { position: 'absolute' as const, top: 85, left: 26, height: 22 }
</script>

<template>
  <!-- Reference coordinates emerge from a vertical Stack: the sole absolute control is the header's close button. -->
  <Stack id="signup-form" :gap="0" :style="{ width: 885, height: 1045, paddingLeft: 52, paddingRight: 73, paddingTop: 44 }">
    <Stack :gap="6">
      <Text id="title" value="Create your account" :size="44" :weight="700" color="label" :style="{ height: 56 }" />
      <Text id="subtitle" value="开始 14 天免费试用，无需信用卡。" :size="22" :weight="500" color="secondaryLabel" :style="{ height: 32 }" />
    </Stack>
    <Button id="close" shape="circle" :style="{ position: 'absolute', left: 782, top: 54, width: 52, height: 52, glass: { scatter: 0.5 } }"><Icon name="x" :size="24" color="secondaryLabel" /></Button>
    <Box :style="{ height: 45, flexShrink: 0 }" />
    <Stack :gap="26">
      <Input id="name" v-model="name" size="large" leading-icon="user" placeholder="Full name" />
      <Stack :gap="0">
        <Input id="email" v-model="email" size="large" leading-icon="mail" placeholder="Email address" />
        <Text v-if="errors?.email" id="email-error" :value="errors.email" :size="16" color="danger" :style="errorStyle" />
      </Stack>
      <Stack :gap="0">
        <Input id="password" v-model="password" type="password" size="large" leading-icon="lock" placeholder="Password" @submit="submit" />
        <Text v-if="errors?.password" id="password-error" :value="errors.password" :size="16" color="danger" :style="errorStyle" />
      </Stack>
    </Stack>
    <Box :style="{ height: 42, flexShrink: 0 }" />
    <Stack direction="horizontal" align="center" justify="between" :style="{ height: 62, flexShrink: 0 }">
      <Checkbox id="terms" v-model:checked="terms"><Text value="I agree to the Terms & Privacy" :size="21" :weight="500" :color="body" /></Checkbox>
      <Stack direction="horizontal" :gap="16" align="center" :style="{ width: 302 }">
        <Text id="remember-label" value="Remember me" :size="20" :weight="500" :color="body" align="right" :style="{ width: 150 }" @click="remember = !remember" />
        <Switch id="remember" v-model:checked="remember" />
      </Stack>
    </Stack>
    <Box :style="{ height: 42, flexShrink: 0 }" />
    <Button id="submit" variant="glassProminent" size="large" label="Create account" trailing-icon="arrow-right" full-width :loading="loading" :style="{ height: 84, glass: { glow: { color: 'accent', strength: 1.15 }, tint: '#817af7', absorption: 1.4 } }" @press="submit" />
    <Box :style="{ height: 27, flexShrink: 0 }" />
    <Text value="or continue with" :size="19" :weight="500" color="tertiaryLabel" align="center" :style="{ height: 30, width: 885, marginLeft: -52 }" />
    <Box :style="{ height: 22, flexShrink: 0 }" />
    <Stack direction="horizontal" :gap="15" :style="{ paddingLeft: 8, width: 760 }">
      <Button id="apple" size="large" :style="{ width: 365, height: 78 }"><Text value="Apple" :size="23" :weight="600" /><template #leading><Icon name="apple" :size="28" /></template></Button>
      <Button id="google" size="large" :style="{ width: 365, height: 78 }"><Text value="Google" :size="23" :weight="600" /><template #leading><Icon name="google" :size="28" /></template></Button>
    </Stack>
    <Box :style="{ height: 63, flexShrink: 0 }" />
    <Stack direction="horizontal" justify="center" align="center" :gap="10" :style="{ height: 30, width: 885, marginLeft: -52 }">
      <Text value="Already have an account?" :size="20" :weight="500" color="secondaryLabel" />
      <Text id="signin" value="Sign in" :size="20" :weight="700" color="accent" />
    </Stack>
  </Stack>
</template>
