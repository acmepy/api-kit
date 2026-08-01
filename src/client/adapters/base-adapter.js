export class BaseAdapter {
  async get() {
    throw new Error("BaseAdapter.get debe implementarse");
  }

  async set() {
    throw new Error("BaseAdapter.set debe implementarse");
  }

  async remove() {
    throw new Error("BaseAdapter.remove debe implementarse");
  }
}
