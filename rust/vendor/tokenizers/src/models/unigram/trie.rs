// Modified for scrybe: the trie is built once from borrowed keys and stored as flat arrays (one
// record per node plus one label and one child index per edge) instead of a hash map per node.
// Lookups give the same results; for a 250k-token vocabulary it takes about 13 MB, not ~280 MB.
use std::hash::Hash;

impl<Label: Eq + Hash + Copy + Ord> Trie<Label> {
    pub fn from_keys<'a, I>(keys: I) -> Self
    where
        I: Iterator<Item = &'a [Label]>,
        Label: 'a,
    {
        let mut keys: Vec<&[Label]> = keys.collect();
        keys.sort_unstable();
        keys.dedup();
        let mut trie = Trie::default();
        // Breadth-first: node i is the i-th range queued, so a node's children are contiguous.
        let mut queue: Vec<(usize, usize, usize)> = vec![(0, keys.len(), 0)];
        let mut head = 0;
        while head < queue.len() {
            let (mut start, end, depth) = queue[head];
            head += 1;
            let mut is_leaf = false;
            // Sorted order puts the key that ends here (at most one after dedup) first.
            if start < end && keys[start].len() == depth {
                is_leaf = true;
                start += 1;
            }
            let first = trie.labels.len() as u32;
            let mut i = start;
            while i < end {
                let label = keys[i][depth];
                let mut j = i + 1;
                while j < end && keys[j][depth] == label {
                    j += 1;
                }
                trie.labels.push(label);
                trie.targets.push(queue.len() as u32);
                queue.push((i, j, depth + 1));
                i = j;
            }
            let len = trie.labels.len() as u32 - first;
            trie.nodes.push(Node { first, len, is_leaf });
        }
        trie.nodes.shrink_to_fit();
        trie.labels.shrink_to_fit();
        trie.targets.shrink_to_fit();
        trie
    }
}

#[derive(Clone)]
pub struct Trie<Label> {
    nodes: Vec<Node>,
    labels: Vec<Label>,
    targets: Vec<u32>,
}

impl<Label: Eq + Hash + Copy + Ord> Trie<Label> {
    pub fn common_prefix_search<T>(&self, iterator: T) -> TrieIterator<'_, Label, T>
    where
        T: Iterator<Item = Label>,
    {
        TrieIterator {
            trie: self,
            node: 0,
            prefix: vec![],
            iterator,
        }
    }

    fn child(&self, node: u32, label: Label) -> Option<u32> {
        let n = self.nodes.get(node as usize)?;
        let (first, len) = (n.first as usize, n.len as usize);
        let k = self.labels[first..first + len].binary_search(&label).ok()?;
        Some(self.targets[first + k])
    }
}

pub struct TrieIterator<'a, Label, T> {
    trie: &'a Trie<Label>,
    node: u32,
    prefix: Vec<Label>,
    iterator: T,
}

impl<Label, T> Iterator for TrieIterator<'_, Label, T>
where
    Label: Eq + Hash + Copy + Ord,
    T: Iterator<Item = Label>,
{
    type Item = Vec<Label>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let label = self.iterator.next()?;
            self.prefix.push(label);
            self.node = self.trie.child(self.node, label)?;
            if self.trie.nodes[self.node as usize].is_leaf {
                return Some(self.prefix.clone());
            }
        }
    }
}

impl<Label> Default for Trie<Label> {
    fn default() -> Self {
        Self {
            nodes: vec![],
            labels: vec![],
            targets: vec![],
        }
    }
}

#[derive(Clone, Copy)]
struct Node {
    first: u32,
    len: u32,
    is_leaf: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(trie: &Trie<u8>, text: &str) -> Vec<String> {
        trie.common_prefix_search(text.bytes()).map(|p| String::from_utf8(p).unwrap()).collect()
    }

    #[test]
    fn prefix_search_returns_every_stored_prefix_in_order() {
        let words = ["a", "ab", "abc", "b", "abd", "ab", "xyz"];
        let trie = Trie::from_keys(words.iter().map(|w| w.as_bytes()));
        assert_eq!(found(&trie, "abcd"), vec!["a", "ab", "abc"]);
        assert_eq!(found(&trie, "abd"), vec!["a", "ab", "abd"]);
        assert_eq!(found(&trie, "b"), vec!["b"]);
        assert_eq!(found(&trie, "xy"), Vec::<String>::new());
        assert_eq!(found(&trie, "q"), Vec::<String>::new());
        assert_eq!(found(&trie, ""), Vec::<String>::new());
    }

    #[test]
    fn empty_trie_finds_nothing() {
        let trie = Trie::<u8>::from_keys(std::iter::empty());
        assert_eq!(found(&trie, "abc"), Vec::<String>::new());
    }
}
