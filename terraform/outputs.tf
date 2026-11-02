output "get_credentials" {
  description = "Commands that add both clusters to your kubeconfig (contexts named after the cluster by scripts/contexts.sh)."
  value = [
    for name, c in google_container_cluster.workload :
    "gcloud container clusters get-credentials ${name} --zone ${c.location} --project ${var.project_id}"
  ]
}
