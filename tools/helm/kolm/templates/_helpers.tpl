{{/*
W824-1 — Standard kolm Helm template helpers.

Mirrors the conventions in `helm create` so external operators see a
familiar shape:

  kolm.name          — short app name (truncated to 63 chars per DNS-1123)
  kolm.fullname      — release-qualified name, truncated to 63
  kolm.chart         — chart name + version label
  kolm.labels        — common labels block (app.kubernetes.io/*)
  kolm.selectorLabels — labels used for label-selector matchers
*/}}

{{- define "kolm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kolm.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kolm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kolm.labels" -}}
helm.sh/chart: {{ include "kolm.chart" . }}
{{ include "kolm.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kolm
{{- end -}}

{{- define "kolm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kolm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app: kolm
{{- end -}}

{{/*
Resolve the image tag — fall back to .Chart.AppVersion when values.image.tag
is empty. Keeps the operator's flow simple: `helm install kolm tools/helm/kolm`
just works without forcing them to pin an image tag.
*/}}
{{- define "kolm.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "kolm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kolm.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
