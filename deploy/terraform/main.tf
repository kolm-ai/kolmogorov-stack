# ---------------------------------------------------------------------------
# kolm BYOC — Terraform module
#
# Wraps the Helm chart at ../helm/kolm and installs the kolm gateway onto a
# Kubernetes cluster you already have a kubeconfig for. One `terraform apply`
# stands up: the gateway Deployment, a Service, a PersistentVolumeClaim for
# KOLM_DATA_DIR + the signing keystore, and (optionally) a Secret holding the
# receipt signing secret.
#
# Usage (see deploy/BYOC.md for the full runbook):
#
#   terraform init
#   terraform apply \
#     -var 'receipt_secret=<openssl rand -hex 32>' \
#     -var 'kubeconfig=~/.kube/config'
#
# This module talks ONLY to your cluster. kolm.ai is contacted only if you set
# byoc_enroll_token (the gateway then POSTs an attestation on first boot).
# ---------------------------------------------------------------------------

terraform {
  # >= 1.5 for the strcontains() function used in outputs.
  required_version = ">= 1.5.0"
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.10.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.20.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
variable "kubeconfig" {
  description = "Path to the kubeconfig file for the target cluster."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context to use. Empty = current-context."
  type        = string
  default     = ""
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "kolm"
}

variable "namespace" {
  description = "Namespace to install into (created if missing)."
  type        = string
  default     = "kolm"
}

variable "chart_path" {
  description = "Path to the kolm Helm chart, relative to this module."
  type        = string
  default     = "../helm/kolm"
}

variable "image_repository" {
  description = "Gateway image repository."
  type        = string
  default     = "ghcr.io/sneaky-hippo/kolm-gateway"
}

variable "image_tag" {
  description = "Gateway image tag. Empty = chart appVersion."
  type        = string
  default     = ""
}

variable "receipt_secret" {
  description = <<-EOT
    Receipt signing secret (root of trust for receipt verification). Generate
    with `openssl rand -hex 32`. Leave empty ONLY if existing_secret is set.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "existing_secret" {
  description = "Name of a pre-existing Secret holding RECIPE_RECEIPT_SECRET. Empty = chart creates one."
  type        = string
  default     = ""
}

variable "persistence_size" {
  description = "Size of the PVC backing KOLM_DATA_DIR + signing keystore."
  type        = string
  default     = "10Gi"
}

variable "storage_class" {
  description = "StorageClass for the data PVC. Empty = cluster default."
  type        = string
  default     = ""
}

variable "service_type" {
  description = "Service type: ClusterIP, NodePort, or LoadBalancer."
  type        = string
  default     = "ClusterIP"
}

variable "public_url" {
  description = "Public base URL the gateway advertises in receipts."
  type        = string
  default     = ""
}

variable "byoc_enroll_token" {
  description = "Optional kolm.ai BYOC enroll token. Set to post attestation on first boot."
  type        = string
  default     = ""
  sensitive   = true
}

variable "extra_values" {
  description = "Additional Helm values as a map of dotted-key => string."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
locals {
  has_secret = var.receipt_secret != "" || var.existing_secret != ""
}

resource "null_resource" "validate_secret" {
  count = local.has_secret ? 0 : 1
  # Fail fast with a clear message instead of a confusing Helm template error.
  provisioner "local-exec" {
    command = "echo 'ERROR: set -var receipt_secret=... or -var existing_secret=...' && exit 1"
  }
}

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.kube_context != "" ? var.kube_context : null
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig
    config_context = var.kube_context != "" ? var.kube_context : null
  }
}

# ---------------------------------------------------------------------------
# Release
# ---------------------------------------------------------------------------
resource "helm_release" "kolm" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = var.chart_path
  atomic           = true
  wait             = true
  timeout          = 600

  # Image
  set {
    name  = "image.repository"
    value = var.image_repository
  }
  dynamic "set" {
    for_each = var.image_tag != "" ? [var.image_tag] : []
    content {
      name  = "image.tag"
      value = set.value
    }
  }

  # Receipt signing secret (sensitive)
  dynamic "set_sensitive" {
    for_each = var.receipt_secret != "" ? [var.receipt_secret] : []
    content {
      name  = "secrets.receiptSecret"
      value = set_sensitive.value
    }
  }
  dynamic "set" {
    for_each = var.existing_secret != "" ? [var.existing_secret] : []
    content {
      name  = "secrets.existingSecret"
      value = set.value
    }
  }

  # Persistence
  set {
    name  = "persistence.size"
    value = var.persistence_size
  }
  dynamic "set" {
    for_each = var.storage_class != "" ? [var.storage_class] : []
    content {
      name  = "persistence.storageClass"
      value = set.value
    }
  }

  # Service + public URL
  set {
    name  = "service.type"
    value = var.service_type
  }
  dynamic "set" {
    for_each = var.public_url != "" ? [var.public_url] : []
    content {
      name  = "gateway.publicUrl"
      value = set.value
    }
  }

  # BYOC enrollment (sensitive)
  dynamic "set_sensitive" {
    for_each = var.byoc_enroll_token != "" ? [var.byoc_enroll_token] : []
    content {
      name  = "byoc.enrollToken"
      value = set_sensitive.value
    }
  }

  # Arbitrary extra values
  dynamic "set" {
    for_each = var.extra_values
    content {
      name  = set.key
      value = set.value
    }
  }

  depends_on = [null_resource.validate_secret]
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
output "release_name" {
  description = "Installed Helm release name."
  value       = helm_release.kolm.name
}

output "namespace" {
  description = "Namespace the gateway runs in."
  value       = helm_release.kolm.namespace
}

output "service_name" {
  description = <<-EOT
    In-cluster Service name for the gateway. The chart's fullname collapses to
    just the release name when the chart name ("kolm") is already contained in
    it; with a different release name it becomes "<release>-kolm".
  EOT
  value       = strcontains(helm_release.kolm.name, "kolm") ? helm_release.kolm.name : "${helm_release.kolm.name}-kolm"
}

output "health_check" {
  description = "Command to verify the gateway is live."
  value       = "kubectl -n ${var.namespace} port-forward svc/${strcontains(helm_release.kolm.name, "kolm") ? helm_release.kolm.name : "${helm_release.kolm.name}-kolm"} 8080:80 & sleep 2 && curl -fsS http://127.0.0.1:8080/v1/health"
}
