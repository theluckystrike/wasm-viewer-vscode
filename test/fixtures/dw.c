int add(int a, int b) {
  return a + b;
}

int sum(const int *p, int n) {
  int s = 0;
  for (int i = 0; i < n; i++)
    s = add(s, p[i]);
  return s;
}
